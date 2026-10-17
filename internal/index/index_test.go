package index

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/dunkbing/memory-go/internal/notes"
)

func TestOldIndexIsRebuilt(t *testing.T) {
	file := filepath.Join(t.TempDir(), "index.db")
	// An index from before links existed: old schema, user_version 0.
	db, err := sql.Open("sqlite", "file:"+file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, path TEXT, title TEXT, tags TEXT, mtime INTEGER)`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	ix, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer ix.Close()
	note := notes.Note{Path: "a.md", Title: "A", Body: "see [[B]]"}
	if err := ix.Upsert(note, time.Now()); err != nil {
		t.Fatalf("upsert into migrated index: %v", err)
	}
	if _, missing, err := ix.Outgoing("a.md"); err != nil || len(missing) != 1 {
		t.Fatalf("Outgoing = %v, %v", missing, err)
	}
}
