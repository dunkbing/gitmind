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
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/dunkbing/memory-go/internal/notes"
	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS notes (
	id    INTEGER PRIMARY KEY,
	path  TEXT NOT NULL UNIQUE,
	title TEXT NOT NULL,
	tags  TEXT NOT NULL,
	mtime INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, tags, body, tokenize = 'porter unicode61');
`

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
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("init index: %w", err)
	}
	return &Index{db: db}, nil
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
	var id int64
	err := tx.QueryRow(`SELECT id FROM notes WHERE path = ?`, n.Path).Scan(&id)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		res, err := tx.Exec(`INSERT INTO notes (path, title, tags, mtime) VALUES (?, ?, ?, ?)`,
			n.Path, n.Title, tags, mod.UnixNano())
		if err != nil {
			return err
		}
		if id, err = res.LastInsertId(); err != nil {
			return err
		}
	case err != nil:
		return err
	default:
		if _, err := tx.Exec(`UPDATE notes SET title = ?, tags = ?, mtime = ? WHERE id = ?`,
			n.Title, tags, mod.UnixNano(), id); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM notes_fts WHERE rowid = ?`, id); err != nil {
			return err
		}
	}
	_, err = tx.Exec(`INSERT INTO notes_fts (rowid, title, tags, body) VALUES (?, ?, ?, ?)`,
		id, n.Title, tags, n.Body)
	return err
}

func remove(tx *sql.Tx, p string) error {
	var id int64
	err := tx.QueryRow(`SELECT id FROM notes WHERE path = ?`, p).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM notes_fts WHERE rowid = ?`, id); err != nil {
		return err
	}
	_, err = tx.Exec(`DELETE FROM notes WHERE id = ?`, id)
	return err
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
