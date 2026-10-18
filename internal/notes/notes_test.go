package notes

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestRoundTrip(t *testing.T) {
	n := Note{
		Path:    "myapp/deploy.md",
		Title:   "Deploy: steps & gotchas",
		Tags:    []string{"ops", "deploy"},
		Created: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC),
		Pinned:  true,
		Locked:  true,
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

func TestLinks(t *testing.T) {
	body := "- depends on [[Auth Service]]\n" +
		"- [decision] use JWT, see [[Token format#Claims|claims]] and [[ops/Runbook]]\n" +
		"Prose mentioning [[Auth Service]] again.\n" +
		"```\n[[Not a link]]\n```\n" +
		"- this line explains a lot of things before [[Glossary]]\n"
	want := []Link{
		{Target: "Auth Service", Relation: "depends on"},
		{Target: "Token format"},
		{Target: "ops/Runbook"},
		{Target: "Auth Service"},
		{Target: "Glossary"},
	}
	if got := Links(body); !reflect.DeepEqual(got, want) {
		t.Fatalf("Links =\n%#v\nwant\n%#v", got, want)
	}
	for in, want := range map[string][2]string{
		"Auth Service":   {"", "auth-service"},
		"ops/Runbook.md": {"ops/runbook.md", "runbook"},
		"Đà Nẵng":        {"", "da-nang"},
	} {
		if p, s := LinkTarget(in); p != want[0] || s != want[1] {
			t.Errorf("LinkTarget(%q) = %q, %q; want %q, %q", in, p, s, want[0], want[1])
		}
	}
}

func TestObservationsAndInlineTags(t *testing.T) {
	body := "# Heading is not a tag\n" +
		"- [Decision] use JWT for sessions #auth #Security\n" +
		"- [ ] a todo, not an observation\n" +
		"- [x] a done todo #chore\n" +
		"* [gotcha] tokens expire after 15m (see [[Auth]])\n" +
		"See https://example.com/page#fragment and issue #123.\n" +
		"```\n- [decision] inside code #notatag\n```\n" +
		"Plain prose with a #prose-tag/.\n"
	wantObs := []Observation{
		{Category: "decision", Text: "use JWT for sessions #auth #Security"},
		{Category: "gotcha", Text: "tokens expire after 15m (see [[Auth]])"},
	}
	if got := Observations(body); !reflect.DeepEqual(got, wantObs) {
		t.Errorf("Observations =\n%#v\nwant\n%#v", got, wantObs)
	}
	wantTags := []string{"auth", "security", "chore", "prose-tag"}
	if got := InlineTags(body); !reflect.DeepEqual(got, wantTags) {
		t.Errorf("InlineTags = %q, want %q", got, wantTags)
	}
}

func TestRewriteLinks(t *testing.T) {
	body := "- depends on [[Auth service]] and [[Auth service#Tokens|tokens]]\n" +
		"- path form [[myapp/auth-service]], other [[Billing]]\n" +
		"```\n[[Auth service]] in code\n```\n"
	got, n := RewriteLinks(body, func(target string) (string, bool) {
		switch target {
		case "Auth service":
			return "Identity service", true
		case "myapp/auth-service":
			return "platform/identity-service", true
		}
		return "", false
	})
	want := "- depends on [[Identity service]] and [[Identity service#Tokens|tokens]]\n" +
		"- path form [[platform/identity-service]], other [[Billing]]\n" +
		"```\n[[Auth service]] in code\n```\n"
	if got != want || n != 3 {
		t.Errorf("RewriteLinks = %d changes:\n%s", n, got)
	}
}

func TestReplaceSection(t *testing.T) {
	body := "Intro line.\n\n## Setup ##\n\nold setup\n\n### Details\n\nold details\n\n## Usage\n\nkeep me\n\n```\n## Setup\n```\n"
	got, added, err := ReplaceSection(body, "setup", "- [setup] new setup")
	if err != nil || added {
		t.Fatalf("ReplaceSection: added=%v err=%v", added, err)
	}
	want := "Intro line.\n\n## Setup ##\n\n- [setup] new setup\n\n## Usage\n\nkeep me\n\n```\n## Setup\n```\n"
	if got != want {
		t.Errorf("replace middle section:\n%q\nwant\n%q", got, want)
	}

	got, _, _ = ReplaceSection(body, "## Usage", "replaced usage")
	if !strings.HasSuffix(got, "## Usage\n\nreplaced usage\n") || !strings.Contains(got, "old details") {
		t.Errorf("replace last section:\n%s", got)
	}

	got, added, _ = ReplaceSection("Just text\n", "Open questions", "- why?")
	if !added || got != "Just text\n\n## Open questions\n\n- why?\n" {
		t.Errorf("add missing section: added=%v\n%q", added, got)
	}

	if _, _, err := ReplaceSection("## A\nx\n## A\ny\n", "A", "z"); err == nil {
		t.Error("ambiguous heading accepted")
	}
}

func TestExistsMatchesCaseExactly(t *testing.T) {
	s := Store{Root: t.TempDir()}
	if _, err := s.Write(Note{Path: "work/log.md", Title: "Log"}); err != nil {
		t.Fatal(err)
	}
	if !s.Exists("work/log.md") {
		t.Error("work/log.md not found")
	}
	// On macOS and Windows the filesystem would find these; git wouldn't.
	for _, rel := range []string{"work/Log.md", "Work/log.md"} {
		if s.Exists(rel) {
			t.Errorf("%s found, but the file is work/log.md", rel)
		}
	}
}
