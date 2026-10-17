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

	"github.com/dunkbing/memory-go/internal/notes"
	_ "modernc.org/sqlite"
)

// schemaVersion is bumped whenever the schema changes; an index built with
// another version is dropped and rebuilt from the notes on disk.
const schemaVersion = 3

const schema = `
CREATE TABLE notes (
	id    INTEGER PRIMARY KEY,
	path  TEXT NOT NULL UNIQUE,
	slug  TEXT NOT NULL, -- slugified file name, the main key [[links]] resolve by
	title TEXT NOT NULL,
	title_slug TEXT NOT NULL, -- slugified title, for notes whose title and file name differ
	tags  TEXT NOT NULL,
	mtime INTEGER NOT NULL
);
CREATE INDEX notes_slug ON notes (slug);
CREATE INDEX notes_title_slug ON notes (title_slug);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, tags, body, tokenize = 'porter unicode61');
CREATE TABLE links (
	source_id   INTEGER NOT NULL,
	target      TEXT NOT NULL, -- as written inside [[ ]]
	target_path TEXT NOT NULL, -- exact note path when the link names a directory, else ''
	target_slug TEXT NOT NULL,
	relation    TEXT NOT NULL
);
CREATE INDEX links_source ON links (source_id);
CREATE INDEX links_slug ON links (target_slug);
`

// resolves is the join condition from a links row l to the note t it names.
const resolves = `(l.target_path = t.path OR (l.target_path = '' AND (l.target_slug = t.slug OR l.target_slug = t.title_slug)))`

type Index struct{ db *sql.DB }

type Hit struct {
	Path     string
	Title    string
	Tags     []string
	Modified time.Time
	Snippet  string
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
	for _, table := range []string{"links", "notes_fts", "notes"} {
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

func (ix *Index) Upsert(n notes.Note, mod time.Time) error {
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := upsert(tx, n, mod); err != nil {
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
// notes were added, updated or removed.
func (ix *Index) Sync(st notes.Store) (int, error) {
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
		return upsert(tx, n, mod)
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

func upsert(tx *sql.Tx, n notes.Note, mod time.Time) error {
	tags := strings.Join(n.Tags, " ")
	slug := notes.Slugify(strings.TrimSuffix(path.Base(n.Path), ".md"))
	titleSlug := notes.Slugify(n.Title)
	var id int64
	err := tx.QueryRow(`SELECT id FROM notes WHERE path = ?`, n.Path).Scan(&id)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		res, err := tx.Exec(`INSERT INTO notes (path, slug, title, title_slug, tags, mtime) VALUES (?, ?, ?, ?, ?, ?)`,
			n.Path, slug, n.Title, titleSlug, tags, mod.UnixNano())
		if err != nil {
			return err
		}
		if id, err = res.LastInsertId(); err != nil {
			return err
		}
	case err != nil:
		return err
	default:
		if _, err := tx.Exec(`UPDATE notes SET title = ?, title_slug = ?, tags = ?, mtime = ? WHERE id = ?`,
			n.Title, titleSlug, tags, mod.UnixNano(), id); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM notes_fts WHERE rowid = ?`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM links WHERE source_id = ?`, id); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`INSERT INTO notes_fts (rowid, title, tags, body) VALUES (?, ?, ?, ?)`,
		id, n.Title, tags, n.Body); err != nil {
		return err
	}
	for _, l := range notes.Links(n.Body) {
		targetPath, targetSlug := notes.LinkTarget(l.Target)
		if _, err := tx.Exec(`INSERT INTO links (source_id, target, target_path, target_slug, relation) VALUES (?, ?, ?, ?, ?)`,
			id, l.Target, targetPath, targetSlug, l.Relation); err != nil {
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
	for _, q := range []string{
		`DELETE FROM notes_fts WHERE rowid = ?`,
		`DELETE FROM links WHERE source_id = ?`,
		`DELETE FROM notes WHERE id = ?`,
	} {
		if _, err := tx.Exec(q, id); err != nil {
			return err
		}
	}
	return nil
}

// Search ranks notes by BM25, weighting title over tags over body. Every word
// in query is matched as a prefix and any word may match.
func (ix *Index) Search(query, dir string, limit int) ([]Hit, error) {
	match := ftsQuery(query)
	if match == "" {
		return nil, nil
	}
	rows, err := ix.db.Query(`
		SELECT n.path, n.title, n.tags, n.mtime, snippet(notes_fts, 2, '**', '**', '…', 16)
		FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
		WHERE notes_fts MATCH ? AND (? = '' OR n.path LIKE ? || '/%')
		ORDER BY bm25(notes_fts, 10.0, 5.0, 1.0)
		LIMIT ?`, match, dir, dir, limit)
	if err != nil {
		return nil, err
	}
	return scanHits(rows, true)
}

func (ix *Index) Recent(limit int) ([]Hit, error) {
	rows, err := ix.db.Query(`SELECT path, title, tags, mtime FROM notes ORDER BY mtime DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	return scanHits(rows, false)
}

func (ix *Index) List(dir string) ([]Hit, error) {
	rows, err := ix.db.Query(`SELECT path, title, tags, mtime FROM notes
		WHERE ? = '' OR path LIKE ? || '/%' ORDER BY path`, dir, dir)
	if err != nil {
		return nil, err
	}
	return scanHits(rows, false)
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
		SELECT l.target, l.relation, t.path, t.title, t.tags, t.mtime
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
		var tMtime sql.NullInt64
		if err := rows.Scan(&target, &relation, &tPath, &tTitle, &tTags, &tMtime); err != nil {
			return nil, nil, err
		}
		if !tPath.Valid {
			missing = append(missing, target)
			continue
		}
		hits = append(hits, LinkHit{Hit: Hit{
			Path: tPath.String, Title: tTitle.String, Tags: strings.Fields(tTags.String),
			Modified: time.Unix(0, tMtime.Int64),
		}, Relation: relation})
	}
	return hits, missing, rows.Err()
}

// Backlinks returns the notes that link to p.
func (ix *Index) Backlinks(p string) ([]LinkHit, error) {
	rows, err := ix.db.Query(`
		SELECT DISTINCT s.path, s.title, s.tags, s.mtime, l.relation
		FROM links l JOIN notes s ON s.id = l.source_id
		JOIN notes t ON `+resolves+`
		WHERE t.path = ? AND s.id != t.id
		ORDER BY s.mtime DESC`, p)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hits []LinkHit
	for rows.Next() {
		var h LinkHit
		var tags string
		var mtime int64
		if err := rows.Scan(&h.Path, &h.Title, &tags, &mtime, &h.Relation); err != nil {
			return nil, err
		}
		h.Tags = strings.Fields(tags)
		h.Modified = time.Unix(0, mtime)
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

func scanHits(rows *sql.Rows, withSnippet bool) ([]Hit, error) {
	defer rows.Close()
	var hits []Hit
	for rows.Next() {
		var h Hit
		var tags string
		var mtime int64
		dest := []any{&h.Path, &h.Title, &tags, &mtime}
		if withSnippet {
			dest = append(dest, &h.Snippet)
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		h.Tags = strings.Fields(tags)
		h.Modified = time.Unix(0, mtime)
		hits = append(hits, h)
	}
	return hits, rows.Err()
}

// ftsQuery turns free text into an FTS5 query of quoted prefix terms joined
// by OR, so user input can never be parsed as FTS syntax.
func ftsQuery(q string) string {
	words := strings.FieldsFunc(q, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r) && r != '_'
	})
	terms := make([]string, len(words))
	for i, w := range words {
		terms[i] = `"` + w + `"*`
	}
	return strings.Join(terms, " OR ")
}
