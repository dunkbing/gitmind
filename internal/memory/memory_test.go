package memory

import (
	"context"
	"fmt"
	"io"
	"log"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dunkbing/gitmind/internal/gitsync"
	"github.com/dunkbing/gitmind/internal/index"
	"github.com/dunkbing/gitmind/internal/notes"
)

// machine sets up one "machine": a notes repo cloned from remote.
func machine(t *testing.T, remote, name string) *App {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := gitsync.Init(context.Background(), dir, remote); err != nil {
		t.Fatalf("init %s: %v", name, err)
	}
	app, err := Open(dir, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	app.host = name
	t.Cleanup(app.Close)
	return app
}

func bareRemote(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "remote.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", "-b", "main", dir).CombinedOutput(); err != nil {
		t.Fatalf("git init --bare: %v: %s", err, out)
	}
	return dir
}

func mustSync(t *testing.T, a *App) gitsync.Result {
	t.Helper()
	res, err := a.Sync(context.Background())
	if err != nil {
		t.Fatalf("sync %s: %v", a.host, err)
	}
	return res
}

func TestWriteSearchEditDelete(t *testing.T) {
	ctx := context.Background()
	a := machine(t, "", "laptop")

	rel, created, err := a.Write(ctx, "Deploy checklist", "My App", "- [gotcha] run migrations before restarting #db", []string{"#Ops"}, false)
	if err != nil || !created || rel != "my-app/deploy-checklist.md" {
		t.Fatalf("Write = %q, %v, %v", rel, created, err)
	}
	hits, err := a.Index.Search(index.Query{Text: "migration"})
	if err != nil || len(hits) != 1 || hits[0].Path != rel {
		t.Fatalf("Search = %+v, %v", hits, err)
	}
	if hits, _ := a.Index.Search(index.Query{Text: "ops", Dir: "other-app"}); len(hits) != 0 {
		t.Fatalf("directory filter leaked: %+v", hits)
	}

	for _, id := range []string{rel, "my-app/deploy-checklist", "Deploy checklist", "deploy CHECKLIST"} {
		if got, err := a.Resolve(id); err != nil || got != rel {
			t.Errorf("Resolve(%q) = %q, %v", id, got, err)
		}
	}

	if _, err := a.Edit(ctx, "Deploy checklist", EditOp{Operation: "append", Content: "- [setup] deploys run from CI only"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Edit(ctx, rel, EditOp{Operation: "find_replace", Content: "staging", FindText: "missing text"}); err == nil {
		t.Fatal("find_replace of missing text succeeded")
	}
	n, _, _ := a.Store.Read(rel)
	if !strings.Contains(n.Body, "migrations") || !strings.Contains(n.Body, "CI only") || n.Tags[0] != "ops" {
		t.Fatalf("unexpected note after edit: %#v", n)
	}

	// Rewriting keeps created and tags.
	if _, created, err := a.Write(ctx, "Deploy checklist", "my-app", "replaced", nil, true); err != nil || created {
		t.Fatalf("rewrite: created=%v err=%v", created, err)
	}
	n2, _, _ := a.Store.Read(rel)
	if n2.Body != "replaced\n" || !n2.Created.Equal(n.Created) || len(n2.Tags) != 1 {
		t.Fatalf("rewrite lost metadata: %#v", n2)
	}

	if _, _, err := a.Write(ctx, "Keys", "", "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx", nil, false); err == nil {
		t.Fatal("secret was saved")
	}

	if _, err := a.Delete(ctx, rel); err != nil {
		t.Fatal(err)
	}
	if hits, _ := a.Index.Recent(10); len(hits) != 0 {
		t.Fatalf("deleted note still indexed: %+v", hits)
	}
	if out, _ := exec.Command("git", "-C", a.Store.Root, "status", "--porcelain").Output(); len(out) != 0 {
		t.Fatalf("uncommitted changes left behind:\n%s", out)
	}
}

func TestSyncBetweenMachines(t *testing.T) {
	ctx := context.Background()
	remote := bareRemote(t)
	laptop := machine(t, remote, "laptop")
	desktop := machine(t, remote, "desktop")

	if _, _, err := laptop.Write(ctx, "Preferences", "general", "- [preference] use pnpm over npm", nil, false); err != nil {
		t.Fatal(err)
	}
	mustSync(t, laptop)
	if res := mustSync(t, desktop); !res.Pulled {
		t.Fatalf("desktop did not pull: %+v", res)
	}
	if hits, _ := desktop.Index.Search(index.Query{Text: "pnpm"}); len(hits) != 1 {
		t.Fatalf("desktop cannot find the laptop's note: %+v", hits)
	}

	// Both machines append to the same note before syncing: the union merge
	// must keep both lines without conflict markers.
	if _, err := laptop.Edit(ctx, "Preferences", EditOp{Operation: "append", Content: "- [preference] tabs in Go, spaces elsewhere"}); err != nil {
		t.Fatal(err)
	}
	if _, err := desktop.Edit(ctx, "Preferences", EditOp{Operation: "append", Content: "- [preference] conventional commits"}); err != nil {
		t.Fatal(err)
	}
	mustSync(t, laptop)
	if res := mustSync(t, desktop); len(res.Conflicts) != 0 {
		t.Fatalf("unexpected conflicts: %v", res.Conflicts)
	}
	mustSync(t, laptop)

	for _, a := range []*App{laptop, desktop} {
		n, _, err := a.Store.Read("general/preferences.md")
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{"pnpm", "tabs in Go", "conventional commits"} {
			if !strings.Contains(n.Body, want) {
				t.Errorf("%s is missing %q:\n%s", a.host, want, n.Body)
			}
		}
		if strings.Contains(n.Body, "<<<<<<<") {
			t.Errorf("%s has conflict markers:\n%s", a.host, n.Body)
		}
	}

	// Edits made outside gitmind (e.g. Obsidian) are committed by sync.
	if _, err := laptop.Store.Write(laptop.mustRead(t, "general/preferences.md", "- [preference] dark mode")); err != nil {
		t.Fatal(err)
	}
	if res := mustSync(t, laptop); !res.Committed || !res.Pushed {
		t.Fatalf("external edit not synced: %+v", res)
	}
	mustSync(t, desktop)
	if hits, _ := desktop.Index.Search(index.Query{Text: "dark"}); len(hits) != 1 {
		t.Fatalf("external edit did not reach desktop: %+v", hits)
	}
}

func (a *App) mustRead(t *testing.T, rel, appendLine string) notes.Note {
	t.Helper()
	n, _, err := a.Store.Read(rel)
	if err != nil {
		t.Fatal(err)
	}
	n.Body += appendLine + "\n"
	return n
}

func TestCommitsNameTheAgent(t *testing.T) {
	a := machine(t, "", "laptop")
	a.SetClient("claude-code")
	if _, _, err := a.Write(context.Background(), "Deploy", "ops", "- run deploy.sh", nil, false); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("git", "-C", a.Store.Root, "log", "-1", "--format=%s").Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(out)); got != "memory: add ops/deploy.md (laptop, claude-code)" {
		t.Errorf("commit message = %q", got)
	}
}

func TestSessionProfile(t *testing.T) {
	ctx := context.Background()
	a := machine(t, "", "laptop")
	write := func(title, dir, body string) {
		t.Helper()
		if _, _, err := a.Write(ctx, title, dir, body, nil, false); err != nil {
			t.Fatal(err)
		}
	}
	write("Working style", "general", "- [instruction] One-line commit messages #git\n- [preference] Use bun, not npm #tooling\n- [decision] Not a profile fact\n\n## History\n\n- [instruction] Write long commit bodies (until 2026-10-01)\n")
	write("Shop conventions", "shop", "- [instruction] Prices are stored in cents\n- [preference] use bun, not npm.\n")
	write("Other project", "blog", "- [instruction] Only for the blog\n")
	write("Pinned rules", "general", "- [instruction] Shown in full instead\n")
	if _, err := a.Pin(ctx, "Pinned rules", true); err != nil {
		t.Fatal(err)
	}

	out, err := a.SessionContext("shop", 8000)
	if err != nil {
		t.Fatal(err)
	}
	profile := out[strings.Index(out, "## Profile"):strings.Index(out, "## Pinned notes")]
	for _, want := range []string{"- [instruction] One-line commit messages (Working style)", "- [instruction] Prices are stored in cents (Shop conventions)", "- [preference] use bun, not npm. (Shop conventions)"} {
		if !strings.Contains(profile, want) {
			t.Errorf("profile lacks %q:\n%s", want, profile)
		}
	}
	for _, unwanted := range []string{"long commit bodies", "Only for the blog", "Not a profile fact", "Shown in full", "Use bun, not npm (Working style)"} {
		if strings.Contains(profile, unwanted) {
			t.Errorf("profile has %q:\n%s", unwanted, profile)
		}
	}
	if strings.Index(profile, "[preference]") < strings.Index(profile, "Prices are stored") {
		t.Errorf("instructions should come before preferences:\n%s", profile)
	}

	// The same fact in two notes appears once, in the newest wording.
	// Caps: no more than 40 facts, then a pointer to the rest.
	var many strings.Builder
	for i := 0; i < 60; i++ {
		fmt.Fprintf(&many, "- [instruction] Rule number %d\n", i)
	}
	write("Many rules", "general", many.String())
	out, _ = a.SessionContext("shop", 30000)
	profile = out[strings.Index(out, "## Profile"):strings.Index(out, "## Pinned notes")]
	if n := strings.Count(profile, "- [instruction] Rule number"); n > 40 {
		t.Errorf("%d facts shown, want at most 40", n)
	}
	if !strings.Contains(out, "more (search_notes category") {
		t.Errorf("no pointer to the rest of the profile:\n%s", out)
	}
}
