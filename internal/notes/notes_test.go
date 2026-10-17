package notes

import (
	"reflect"
	"testing"
	"time"
)

func TestRoundTrip(t *testing.T) {
	n := Note{
		Path:    "myapp/deploy.md",
		Title:   "Deploy: steps & gotchas",
		Tags:    []string{"ops", "deploy"},
		Created: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC),
		Extra:   []string{"type: note", "aliases:", "  - shipping"},
		Body:    "- [gotcha] run migrations first #db\n",
	}
	got := Parse(n.Path, n.Format())
	if !reflect.DeepEqual(got, n) {
		t.Fatalf("round trip mismatch\n got: %#v\nwant: %#v", got, n)
	}
}

func TestParseBasicMemoryNote(t *testing.T) {
	src := "---\ntitle: Memory server setup\ntype: note\npermalink: setup/memory-server-setup\ntags:\n- infra\n- '#VPS'\n---\n\nBody here.\n"
	n := Parse("setup/memory-server-setup.md", []byte(src))
	if n.Title != "Memory server setup" {
		t.Errorf("title = %q", n.Title)
	}
	if want := []string{"infra", "vps"}; !reflect.DeepEqual(n.Tags, want) {
		t.Errorf("tags = %q, want %q", n.Tags, want)
	}
	if want := []string{"type: note", "permalink: setup/memory-server-setup"}; !reflect.DeepEqual(n.Extra, want) {
		t.Errorf("extra = %q, want %q", n.Extra, want)
	}
	if n.Body != "Body here.\n" {
		t.Errorf("body = %q", n.Body)
	}
}

func TestParseWithoutFrontmatter(t *testing.T) {
	n := Parse("general/plain.md", []byte("# Just text\n"))
	if n.Title != "plain" || n.Body != "# Just text\n" {
		t.Fatalf("got %#v", n)
	}
}

func TestSlugifyAndCleanDir(t *testing.T) {
	for in, want := range map[string]string{
		"Deploy: steps & gotchas": "deploy-steps-gotchas",
		"  Hello   World  ":       "hello-world",
		"Tiếng Việt":              "tieng-viet",
		"Đà Nẵng đường phố":       "da-nang-duong-pho",
		"Straße & Øl":             "strasse-ol",
		"Café (decomposed)":      "cafe-decomposed",
		"東京 notes":                "東京-notes",
		"한국어":                     "한국어",
		"!!!":                     "note",
	} {
		if got := Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
	if got, err := CleanDir("/My App/Ops Notes/"); err != nil || got != "my-app/ops-notes" {
		t.Errorf("CleanDir = %q, %v", got, err)
	}
	if _, err := CleanDir("a/../../etc"); err == nil {
		t.Error("CleanDir accepted a parent reference")
	}
}

func TestStoreRejectsEscapes(t *testing.T) {
	s := Store{Root: t.TempDir()}
	for _, p := range []string{"../x.md", ".git/config.md", "/etc/passwd.md", "notes.txt"} {
		if _, err := s.Write(Note{Path: p, Title: "x"}); err == nil {
			t.Errorf("Write(%q) succeeded", p)
		}
	}
}
