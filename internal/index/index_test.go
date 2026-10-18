package index

import (
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/dunkbing/gitmind/internal/notes"
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
	if err := ix.Upsert(note, time.Now(), time.Now()); err != nil {
		t.Fatalf("upsert into migrated index: %v", err)
	}
	if _, missing, err := ix.Outgoing("a.md"); err != nil || len(missing) != 1 {
		t.Fatalf("Outgoing = %v, %v", missing, err)
	}
}

func newIndex(t *testing.T, ns ...notes.Note) *Index {
	t.Helper()
	ix, err := Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ix.Close() })
	return ix
}

func add(t *testing.T, ix *Index, p, title, body string, age time.Duration, tags ...string) {
	t.Helper()
	at := time.Now().Add(-age)
	if err := ix.Upsert(notes.Note{Path: p, Title: title, Tags: tags, Body: body}, at, at); err != nil {
		t.Fatal(err)
	}
}

func paths(hits []Hit) []string {
	var out []string
	for _, h := range hits {
		out = append(out, h.Path)
	}
	return out
}

func TestSearchRanking(t *testing.T) {
	day := 24 * time.Hour
	ix := newIndex(t)
	add(t, ix, "both.md", "Eviction", "redis cache eviction policy", 400*day)
	add(t, ix, "redis.md", "Redis", "redis redis redis cluster", 0)
	add(t, ix, "cache.md", "Cache", "cache cache cache headers", 0)
	add(t, ix, "old.md", "Deploy old", "deploy steps", 300*day)
	add(t, ix, "new.md", "Deploy new", "deploy steps", day)

	// A note with every word beats newer, keyword-heavy notes with only one.
	hits, err := ix.Search(Query{Text: "redis cache"})
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(hits); len(got) != 3 || got[0] != "both.md" {
		t.Errorf("redis cache = %v, want both.md first then the partial matches", got)
	}
	// Equal text: the recent note wins.
	if got := paths(mustSearch(t, ix, Query{Text: "deploy steps"})); len(got) != 2 || got[0] != "new.md" {
		t.Errorf("deploy steps = %v, want new.md first", got)
	}
	// The AND pass alone fills the limit without padding from the OR pass.
	if got := paths(mustSearch(t, ix, Query{Text: "redis cache", Limit: 1})); len(got) != 1 || got[0] != "both.md" {
		t.Errorf("limit 1 = %v", got)
	}
}

func TestSearchFilters(t *testing.T) {
	day := 24 * time.Hour
	ix := newIndex(t)
	add(t, ix, "app/auth.md", "Auth", "- [decision] use JWT #security\n- [gotcha] clock skew breaks tokens", 2*day)
	add(t, ix, "app/db.md", "DB", "- [decision] Postgres over MySQL\n- [ ] migrate users", 40*day, "Database")
	add(t, ix, "other/ui.md", "UI", "- [decision] Tailwind #frontend", 5*day)
	add(t, ix, "general/prefs.md", "Prefs", "- [preference] pnpm #security", 100*day)

	cases := []struct {
		name string
		q    Query
		want []string
	}{
		{"inline tag", Query{Tags: []string{"#Security"}}, []string{"app/auth.md", "general/prefs.md"}},
		{"frontmatter tag", Query{Tags: []string{"database"}}, []string{"app/db.md"}},
		{"two tags", Query{Tags: []string{"security", "frontend"}}, nil},
		{"category, newest first", Query{Category: "Decision"}, []string{"app/auth.md", "other/ui.md", "app/db.md"}},
		{"category in dir", Query{Category: "decision", Dir: "app"}, []string{"app/auth.md", "app/db.md"}},
		{"since", Query{Since: time.Now().Add(-7 * day)}, []string{"app/auth.md", "other/ui.md"}},
		{"before", Query{Before: time.Now().Add(-30 * day)}, []string{"app/db.md", "general/prefs.md"}},
		{"text and category", Query{Text: "postgres", Category: "decision"}, []string{"app/db.md"}},
		{"task boxes aren't categories", Query{Category: " "}, []string{"app/auth.md", "other/ui.md", "app/db.md", "general/prefs.md"}},
	}
	for _, c := range cases {
		got := paths(mustSearch(t, ix, c.q))
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}

	hits := mustSearch(t, ix, Query{Category: "decision", Dir: "app"})
	if want := []string{"use JWT #security"}; !reflect.DeepEqual(hits[0].Observations, want) {
		t.Errorf("observations = %q, want %q", hits[0].Observations, want)
	}
}

func mustSearch(t *testing.T, ix *Index, q Query) []Hit {
	t.Helper()
	hits, err := ix.Search(q)
	if err != nil {
		t.Fatal(err)
	}
	return hits
}
