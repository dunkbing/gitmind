// Package index keeps a local SQLite FTS5 search index over the notes.
//
// The index is a cache: it lives outside git, and Sync rebuilds whatever
// changed on disk (local edits, git pulls) by comparing modification times.
package index

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/dunkbing/gitmind/internal/notes"
	_ "modernc.org/sqlite"
)

// schemaVersion is bumped whenever the schema changes; an index built with
// another version is dropped and rebuilt from the notes on disk.
const schemaVersion = 6

const schema = `
CREATE TABLE notes (
	id         INTEGER PRIMARY KEY,
	path       TEXT NOT NULL UNIQUE,
	slug       TEXT NOT NULL, -- slugified file name, the main key [[links]] resolve by
	title      TEXT NOT NULL,
	title_slug TEXT NOT NULL, -- slugified title, for notes whose title and file name differ
	tags       TEXT NOT NULL, -- frontmatter and inline tags, space separated
	summary    TEXT NOT NULL,    -- first meaningful line, for note indexes
	pinned     INTEGER NOT NULL,
	mtime      INTEGER NOT NULL, -- file modification time, only for change detection
	updated    INTEGER NOT NULL  -- when the note last really changed, for ordering and display
);
CREATE INDEX notes_slug ON notes (slug);
CREATE INDEX notes_title_slug ON notes (title_slug);
CREATE INDEX notes_updated ON notes (updated);
-- body is the note without its History sections, which go in history.
CREATE VIRTUAL TABLE notes_fts USING fts5(title, tags, body, history, tokenize = 'porter unicode61');
CREATE TABLE links (
	source_id   INTEGER NOT NULL,
	target      TEXT NOT NULL, -- as written inside [[ ]]
	target_path TEXT NOT NULL, -- exact note path when the link names a directory, else ''
	target_slug TEXT NOT NULL,
	relation    TEXT NOT NULL
);
CREATE INDEX links_source ON links (source_id);
CREATE INDEX links_slug ON links (target_slug);
CREATE TABLE note_tags (note_id INTEGER NOT NULL, tag TEXT NOT NULL);
CREATE INDEX note_tags_tag ON note_tags (tag, note_id);
-- current is 0 for facts kept under a History heading.
CREATE TABLE observations (note_id INTEGER NOT NULL, category TEXT NOT NULL, text TEXT NOT NULL, current INTEGER NOT NULL);
CREATE INDEX observations_category ON observations (category, note_id);
`

var tables = []string{"observations", "note_tags", "links", "notes_fts", "notes"}

// resolves is the join condition from a links row l to the note t it names.
const resolves = `(l.target_path = t.path OR (l.target_path = '' AND (l.target_slug = t.slug OR l.target_slug = t.title_slug)))`

type Index struct{ db *sql.DB }

type Hit struct {
	Path         string
	Title        string
	Tags         []string
	Modified     time.Time
	Snippet      string
	Summary      string
	Pinned       bool
	Observations []string // lines matching Query.Category, when filtering by category
	History      bool     // matched only in the note's History, with Query.IncludeHistory
}

func Open(file string) (*Index, error) {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", "file:"+file+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("init index: %w", err)
	}
	return &Index{db: db}, nil
}

func migrate(db *sql.DB) error {
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	if version == schemaVersion {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range tables {
		if _, err := tx.Exec(`DROP TABLE IF EXISTS ` + table); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(schema); err != nil {
		return err
	}
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, schemaVersion)); err != nil {
		return err
	}
	return tx.Commit()
}

func (ix *Index) Close() error { return ix.db.Close() }

// Upsert indexes n, whose file has modification time mod and whose content
// last changed at updated.
func (ix *Index) Upsert(n notes.Note, mod, updated time.Time) error {
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := upsert(tx, n, mod, updated); err != nil {
		return err
	}
	return tx.Commit()
}

func (ix *Index) Remove(p string) error {
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := remove(tx, p); err != nil {
		return err
	}
	return tx.Commit()
}

// Sync brings the index in line with the files in st and returns how many
// notes were added, updated or removed. updatedAt reports when a changed
// file's content last really changed; a file's modification time alone is
// misleading, since a git pull resets it.
func (ix *Index) Sync(st notes.Store, updatedAt func(rel string, mod time.Time) time.Time) (int, error) {
	known := map[string]int64{}
	rows, err := ix.db.Query(`SELECT path, mtime FROM notes`)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var p string
		var m int64
		if err := rows.Scan(&p, &m); err != nil {
			rows.Close()
			return 0, err
		}
		known[p] = m
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	tx, err := ix.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	changed := 0
	seen := map[string]bool{}
	err = st.Walk(func(rel string, mod time.Time) error {
		seen[rel] = true
		if m, ok := known[rel]; ok && m == mod.UnixNano() {
			return nil
		}
		n, _, err := st.Read(rel)
		if err != nil {
			return err
		}
		changed++
		return upsert(tx, n, mod, updatedAt(rel, mod))
	})
	if err != nil {
		return 0, err
	}
	for p := range known {
		if !seen[p] {
			if err := remove(tx, p); err != nil {
				return 0, err
			}
			changed++
		}
	}
	return changed, tx.Commit()
}

func upsert(tx *sql.Tx, n notes.Note, mod, updated time.Time) error {
	allTags := notes.NormalizeTags(append(append([]string{}, n.Tags...), notes.InlineTags(n.Body)...))
	tags := strings.Join(allTags, " ")
	slug := notes.Slugify(strings.TrimSuffix(path.Base(n.Path), ".md"))
	titleSlug := notes.Slugify(n.Title)
	var id int64
	err := tx.QueryRow(`SELECT id FROM notes WHERE path = ?`, n.Path).Scan(&id)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		res, err := tx.Exec(`INSERT INTO notes (path, slug, title, title_slug, tags, summary, pinned, mtime, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			n.Path, slug, n.Title, titleSlug, tags, notes.Summary(n.Body), n.Pinned, mod.UnixNano(), updated.UnixNano())
		if err != nil {
			return err
		}
		if id, err = res.LastInsertId(); err != nil {
			return err
		}
	case err != nil:
		return err
	default:
		if _, err := tx.Exec(`UPDATE notes SET title = ?, title_slug = ?, tags = ?, summary = ?, pinned = ?, mtime = ?, updated = ? WHERE id = ?`,
			n.Title, titleSlug, tags, notes.Summary(n.Body), n.Pinned, mod.UnixNano(), updated.UnixNano(), id); err != nil {
			return err
		}
		if err := removeDerived(tx, id); err != nil {
			return err
		}
	}
	current, history := notes.SplitHistory(n.Body)
	if _, err := tx.Exec(`INSERT INTO notes_fts (rowid, title, tags, body, history) VALUES (?, ?, ?, ?, ?)`,
		id, n.Title, tags, current, history); err != nil {
		return err
	}
	for _, l := range notes.Links(n.Body) {
		targetPath, targetSlug := notes.LinkTarget(l.Target)
		if _, err := tx.Exec(`INSERT INTO links (source_id, target, target_path, target_slug, relation) VALUES (?, ?, ?, ?, ?)`,
			id, l.Target, targetPath, targetSlug, l.Relation); err != nil {
			return err
		}
	}
	for _, t := range allTags {
		if _, err := tx.Exec(`INSERT INTO note_tags (note_id, tag) VALUES (?, ?)`, id, t); err != nil {
			return err
		}
	}
	for i, part := range []string{current, history} {
		for _, o := range notes.Observations(part) {
			if _, err := tx.Exec(`INSERT INTO observations (note_id, category, text, current) VALUES (?, ?, ?, ?)`, id, o.Category, o.Text, i == 0); err != nil {
				return err
			}
		}
	}
	return nil
}

// removeDerived deletes everything indexed from a note's content.
func removeDerived(tx *sql.Tx, id int64) error {
	for _, q := range []string{
		`DELETE FROM notes_fts WHERE rowid = ?`,
		`DELETE FROM links WHERE source_id = ?`,
		`DELETE FROM note_tags WHERE note_id = ?`,
		`DELETE FROM observations WHERE note_id = ?`,
	} {
		if _, err := tx.Exec(q, id); err != nil {
			return err
		}
	}
	return nil
}

func remove(tx *sql.Tx, p string) error {
	var id int64
	err := tx.QueryRow(`SELECT id FROM notes WHERE path = ?`, p).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	if err := removeDerived(tx, id); err != nil {
		return err
	}
	_, err = tx.Exec(`DELETE FROM notes WHERE id = ?`, id)
	return err
}

// Query describes a search. Text and every filter are optional; filters
// combine with AND.
type Query struct {
	Text     string
	Dir      string    // only notes under this directory
	Tags     []string  // only notes with all of these tags
	Category string    // only notes with observations in this category
	Since    time.Time // only notes updated at or after this time
	Before   time.Time // only notes last updated before this time
	Limit    int
	// IncludeHistory also matches facts kept under History headings, which
	// are otherwise left out; notes matched only there come last.
	IncludeHistory bool
}

// recencyBoost scales BM25 scores (negative; lower is better) by up to 1.3x
// for notes updated just now, fading to ~1.02x after a year.
const recencyBoost = `(1.0 + 0.3 / (1.0 + (? - n.updated) / 2592000000000000.0))` // 30 days in ns

// Search returns notes matching q. With text, notes containing every word
// rank first (BM25, title over tags over body, nudged towards recent notes),
// followed by notes containing only some words. Without text, matching notes
// come newest first.
func (ix *Index) Search(q Query) ([]Hit, error) {
	if q.Limit <= 0 {
		q.Limit = 10
	}
	filter, args := filterSQL(q)
	var hits []Hit
	var err error
	terms := ftsTerms(q.Text)
	switch {
	case len(terms) == 0:
		hits, err = ix.query(`
			SELECT `+hitColumns+`, ''
			FROM notes n WHERE 1 = 1`+filter+`
			ORDER BY n.updated DESC LIMIT ?`, append(args, q.Limit)...)
	default:
		hits, err = ix.keyword(terms, currentColumns, filter, args, q.Limit)
		if err == nil && q.IncludeHistory && len(hits) < q.Limit {
			var more []Hit
			more, err = ix.keyword(terms, historyColumn, filter, args, q.Limit)
			for i := range more {
				more[i].History = true
			}
			hits = appendNew(hits, more, q.Limit)
		}
	}
	if err != nil {
		return nil, err
	}
	if q.Category != "" {
		for i := range hits {
			if hits[i].Observations, err = ix.observations(hits[i].Path, q.Category, q.IncludeHistory); err != nil {
				return nil, err
			}
		}
	}
	return hits, nil
}

// The FTS columns searched: the note without its History sections, or the
// History sections, and the column snippets come from.
type ftsColumns struct {
	filter  string
	snippet int
}

var (
	currentColumns = ftsColumns{"{title tags body}", 2}
	historyColumn  = ftsColumns{"history", 3}
)

// keyword finds notes with every word first, then notes with some words.
func (ix *Index) keyword(terms []string, cols ftsColumns, filter string, args []any, limit int) ([]Hit, error) {
	hits, err := ix.ftsSearch(strings.Join(terms, " "), cols, filter, args, limit)
	if err == nil && len(terms) > 1 && len(hits) < limit {
		var more []Hit
		more, err = ix.ftsSearch(strings.Join(terms, " OR "), cols, filter, args, limit)
		hits = appendNew(hits, more, limit)
	}
	return hits, err
}

func (ix *Index) ftsSearch(match string, cols ftsColumns, filter string, filterArgs []any, limit int) ([]Hit, error) {
	args := append([]any{cols.filter + " : (" + match + ")"}, filterArgs...)
	args = append(args, time.Now().UnixNano(), limit)
	return ix.query(`
		SELECT `+hitColumns+`, snippet(notes_fts, `+fmt.Sprint(cols.snippet)+`, '**', '**', '…', 16)
		FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
		WHERE notes_fts MATCH ?`+filter+`
		ORDER BY bm25(notes_fts, 10.0, 5.0, 1.0, 1.0) * `+recencyBoost+`
		LIMIT ?`, args...)
}

func filterSQL(q Query) (string, []any) {
	var sb strings.Builder
	var args []any
	if q.Dir != "" {
		sb.WriteString(` AND n.path LIKE ? || '/%'`)
		args = append(args, q.Dir)
	}
	for _, t := range notes.NormalizeTags(q.Tags) {
		sb.WriteString(` AND EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag = ?)`)
		args = append(args, t)
	}
	if c := strings.ToLower(strings.TrimSpace(q.Category)); c != "" {
		sb.WriteString(` AND EXISTS (SELECT 1 FROM observations o WHERE o.note_id = n.id AND o.category = ? AND (o.current OR ?))`)
		args = append(args, c, q.IncludeHistory)
	}
	if !q.Since.IsZero() {
		sb.WriteString(` AND n.updated >= ?`)
		args = append(args, q.Since.UnixNano())
	}
	if !q.Before.IsZero() {
		sb.WriteString(` AND n.updated < ?`)
		args = append(args, q.Before.UnixNano())
	}
	return sb.String(), args
}

func (ix *Index) observations(p, category string, includeHistory bool) ([]string, error) {
	rows, err := ix.db.Query(`
		SELECT o.text FROM observations o JOIN notes n ON n.id = o.note_id
		WHERE n.path = ? AND o.category = ? AND (o.current OR ?) ORDER BY o.rowid`, p, strings.ToLower(strings.TrimSpace(category)), includeHistory)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func appendNew(hits, more []Hit, limit int) []Hit {
	seen := map[string]bool{}
	for _, h := range hits {
		seen[h.Path] = true
	}
	for _, h := range more {
		if len(hits) >= limit {
			break
		}
		if !seen[h.Path] {
			hits = append(hits, h)
		}
	}
	return hits
}

// Fact is a current observation and the note it's in.
type Fact struct {
	Path, Title, Category, Text string
}

// CurrentFacts returns the current observations in category ("" for any)
// of the notes under any of dirs ("" for the top level).
func (ix *Index) CurrentFacts(category string, dirs []string) ([]Fact, error) {
	var where []string
	args := []any{strings.ToLower(strings.TrimSpace(category)), strings.ToLower(strings.TrimSpace(category))}
	for _, d := range dirs {
		if d == "" {
			where = append(where, `n.path NOT LIKE '%/%'`)
		} else {
			where = append(where, `n.path LIKE ? || '/%'`)
			args = append(args, d)
		}
	}
	if len(where) == 0 {
		return nil, nil
	}
	rows, err := ix.db.Query(`
		SELECT n.path, n.title, o.category, o.text FROM observations o JOIN notes n ON n.id = o.note_id
		WHERE o.current AND (? = '' OR o.category = ?) AND (`+strings.Join(where, " OR ")+`)
		ORDER BY n.updated DESC, o.rowid`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Fact
	for rows.Next() {
		var f Fact
		if err := rows.Scan(&f.Path, &f.Title, &f.Category, &f.Text); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (ix *Index) Recent(limit int) ([]Hit, error) {
	return ix.query(`SELECT `+hitColumns+`, '' FROM notes n ORDER BY n.updated DESC LIMIT ?`, limit)
}

func (ix *Index) List(dir string) ([]Hit, error) {
	return ix.query(`SELECT `+hitColumns+`, '' FROM notes n
		WHERE ? = '' OR n.path LIKE ? || '/%' ORDER BY n.path`, dir, dir)
}

// Similar returns up to limit other notes whose title or tags share a word
// with n's title or tags: likely duplicates worth merging into.
func (ix *Index) Similar(n notes.Note, limit int) ([]Hit, error) {
	var words []string
	seen := map[string]bool{}
	for _, w := range ftsWords(n.Title + " " + strings.Join(n.Tags, " ")) {
		w = strings.ToLower(w)
		if len([]rune(w)) < 3 || stopWords[w] || seen[w] {
			continue
		}
		seen[w] = true
		words = append(words, `"`+w+`"*`)
	}
	if len(words) == 0 {
		return nil, nil
	}
	return ix.query(`
		SELECT `+hitColumns+`, ''
		FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
		WHERE notes_fts MATCH ? AND n.path != ?
		ORDER BY bm25(notes_fts, 10.0, 5.0, 1.0)
		LIMIT ?`, "{title tags} : ("+strings.Join(words, " OR ")+")", n.Path, limit)
}

// stopWords are too common in titles to suggest a duplicate.
var stopWords = map[string]bool{
	"the": true, "and": true, "for": true, "with": true, "from": true, "into": true, "about": true,
	"notes": true, "note": true, "how": true, "what": true, "why": true, "when": true, "use": true,
	"using": true, "our": true, "new": true, "old": true,
}

// LinkHit is a note on the other end of a link.
type LinkHit struct {
	Hit
	Relation string
}

// Outgoing returns the notes p links to, and the targets of links that don't
// match any note yet.
func (ix *Index) Outgoing(p string) ([]LinkHit, []string, error) {
	rows, err := ix.db.Query(`
		SELECT l.target, l.relation, t.path, t.title, t.tags, t.updated
		FROM links l JOIN notes s ON s.id = l.source_id
		LEFT JOIN notes t ON `+resolves+` AND t.id != s.id
		WHERE s.path = ?
		ORDER BY l.rowid, t.path`, p)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var hits []LinkHit
	var missing []string
	for rows.Next() {
		var target, relation string
		var tPath, tTitle, tTags sql.NullString
		var tUpdated sql.NullInt64
		if err := rows.Scan(&target, &relation, &tPath, &tTitle, &tTags, &tUpdated); err != nil {
			return nil, nil, err
		}
		if !tPath.Valid {
			missing = append(missing, target)
			continue
		}
		hits = append(hits, LinkHit{Hit: Hit{
			Path: tPath.String, Title: tTitle.String, Tags: strings.Fields(tTags.String),
			Modified: time.Unix(0, tUpdated.Int64),
		}, Relation: relation})
	}
	return hits, missing, rows.Err()
}

// Backlinks returns the notes that link to p.
func (ix *Index) Backlinks(p string) ([]LinkHit, error) {
	rows, err := ix.db.Query(`
		SELECT DISTINCT s.path, s.title, s.tags, s.updated, l.relation
		FROM links l JOIN notes s ON s.id = l.source_id
		JOIN notes t ON `+resolves+`
		WHERE t.path = ? AND s.id != t.id
		ORDER BY s.updated DESC`, p)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hits []LinkHit
	for rows.Next() {
		var h LinkHit
		var tags string
		var updated int64
		if err := rows.Scan(&h.Path, &h.Title, &tags, &updated, &h.Relation); err != nil {
			return nil, err
		}
		h.Tags = strings.Fields(tags)
		h.Modified = time.Unix(0, updated)
		hits = append(hits, h)
	}
	return hits, rows.Err()
}

// FindByTitle returns the paths of notes whose title matches, ignoring case.
func (ix *Index) FindByTitle(title string) ([]string, error) {
	rows, err := ix.db.Query(`SELECT path FROM notes WHERE title = ? COLLATE NOCASE ORDER BY path`, title)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var paths []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		paths = append(paths, p)
	}
	return paths, rows.Err()
}

// hitColumns are the notes columns query scans, before the snippet.
const hitColumns = `n.path, n.title, n.tags, n.updated, n.summary, n.pinned`

// query runs a statement selecting hitColumns and then a snippet.
func (ix *Index) query(q string, args ...any) ([]Hit, error) {
	rows, err := ix.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hits []Hit
	for rows.Next() {
		var h Hit
		var tags string
		var updated int64
		if err := rows.Scan(&h.Path, &h.Title, &tags, &updated, &h.Summary, &h.Pinned, &h.Snippet); err != nil {
			return nil, err
		}
		h.Tags = strings.Fields(tags)
		h.Modified = time.Unix(0, updated)
		hits = append(hits, h)
	}
	return hits, rows.Err()
}

// ftsTerms turns free text into quoted FTS5 prefix terms, so user input can
// never be parsed as FTS syntax.
func ftsTerms(q string) []string {
	words := ftsWords(q)
	terms := make([]string, len(words))
	for i, w := range words {
		terms[i] = `"` + w + `"*`
	}
	return terms
}

func ftsWords(s string) []string {
	return strings.FieldsFunc(s, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r) && r != '_'
	})
}
