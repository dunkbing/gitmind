package memory

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dunkbing/gitmind/internal/index"
	"golang.org/x/text/unicode/norm"
)

// git runs git in dir with a fixed identity, so tests don't depend on the
// machine's git config (CI runners have none).
func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=test", "-c", "user.email=test@test"}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// noBackgroundPush keeps the debounced push out of tests that drive pushes
// themselves.
func noBackgroundPush(t *testing.T) {
	old := pushDelay
	pushDelay = time.Hour
	t.Cleanup(func() { pushDelay = old })
}

func TestWriteRefusesOverwrite(t *testing.T) {
	ctx := context.Background()
	a := machine(t, "", "laptop")
	rel, _, err := a.Write(ctx, "Ghi chú Đà Nẵng", "general", "original", nil, false)
	if err != nil {
		t.Fatal(err)
	}
	if rel != "general/ghi-chu-da-nang.md" {
		t.Fatalf("path = %q", rel)
	}
	// Same title typed with decomposed accents, as macOS input can produce.
	nfd := norm.NFD.String("Ghi chú Đà Nẵng")
	_, _, err = a.Write(ctx, nfd, "general", "clobbered", nil, false)
	if err == nil || !strings.Contains(err.Error(), "edit_note") {
		t.Fatalf("expected an already-exists error pointing to edit_note, got %v", err)
	}
	n, _, _ := a.Store.Read(rel)
	if n.Body != "original\n" {
		t.Fatalf("note was overwritten: %q", n.Body)
	}
	if got, err := a.Resolve(nfd); err != nil || got != rel {
		t.Fatalf("Resolve(NFD title) = %q, %v", got, err)
	}
	if _, created, err := a.Write(ctx, "Ghi chú Đà Nẵng", "general", "replaced", nil, true); err != nil || created {
		t.Fatalf("overwrite: created=%v err=%v", created, err)
	}
}

func TestConcurrentEditsKeepEveryChange(t *testing.T) {
	noBackgroundPush(t)
	ctx := context.Background()
	a := machine(t, "", "laptop")
	if _, _, err := a.Write(ctx, "Log", "", "- start", nil, false); err != nil {
		t.Fatal(err)
	}
	// A second App on the same directory stands in for a second agent
	// session on the same machine.
	b, err := Open(a.Store.Root, a.Log)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()

	const n = 20
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			app := a
			if i%2 == 1 {
				app = b
			}
			_, err := app.Edit(ctx, "Log", EditOp{Operation: "append", Content: fmt.Sprintf("- item %02d", i)})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	note, _, _ := a.Store.Read("log.md")
	for i := range n {
		if !strings.Contains(note.Body, fmt.Sprintf("- item %02d", i)) {
			t.Errorf("lost edit %d:\n%s", i, note.Body)
		}
	}
	if status := git(t, a.Store.Root, "status", "--porcelain"); status != "" {
		t.Fatalf("uncommitted changes:\n%s", status)
	}
}

func TestModifyDeleteConflictKeepsTheNote(t *testing.T) {
	noBackgroundPush(t)
	ctx := context.Background()
	remote := bareRemote(t)
	laptop := machine(t, remote, "laptop")
	desktop := machine(t, remote, "desktop")
	if _, _, err := laptop.Write(ctx, "Runbook", "ops", "- [setup] step one", nil, false); err != nil {
		t.Fatal(err)
	}
	mustSync(t, laptop)
	mustSync(t, desktop)

	// The laptop deletes the note while the desktop adds to it: union merge
	// can't resolve that, so this is a real conflict.
	if _, err := laptop.Delete(ctx, "Runbook"); err != nil {
		t.Fatal(err)
	}
	mustSync(t, laptop)
	if _, err := desktop.Edit(ctx, "Runbook", EditOp{Operation: "append", Content: "- [setup] step two"}); err != nil {
		t.Fatal(err)
	}
	res := mustSync(t, desktop)
	if len(res.Conflicts) != 1 || res.Conflicts[0] != "ops/runbook.md" || !res.Pushed {
		t.Fatalf("expected a pushed conflict on ops/runbook.md, got %+v", res)
	}
	if !strings.Contains(res.String(), "ops/runbook.md") {
		t.Errorf("sync summary doesn't name the conflict: %s", res)
	}

	// The edited note wins over the delete, on both machines.
	mustSync(t, laptop)
	for _, a := range []*App{laptop, desktop} {
		n, _, err := a.Store.Read("ops/runbook.md")
		if err != nil {
			t.Fatalf("%s lost the note: %v", a.host, err)
		}
		if !strings.Contains(n.Body, "step two") {
			t.Errorf("%s is missing the edit:\n%s", a.host, n.Body)
		}
		if _, err := os.Stat(filepath.Join(a.Store.Root, ".git", "MERGE_HEAD")); err == nil {
			t.Errorf("%s was left mid-merge", a.host)
		}
	}
}

func TestPushRetriesAfterRejection(t *testing.T) {
	noBackgroundPush(t)
	ctx := context.Background()
	remote := bareRemote(t)
	laptop := machine(t, remote, "laptop")
	desktop := machine(t, remote, "desktop")
	mustSync(t, laptop)
	mustSync(t, desktop)

	if _, _, err := laptop.Write(ctx, "From laptop", "", "laptop note", nil, false); err != nil {
		t.Fatal(err)
	}
	if _, _, err := desktop.Write(ctx, "From desktop", "", "desktop note", nil, false); err != nil {
		t.Fatal(err)
	}
	mustSync(t, desktop)

	// The laptop is now behind origin, so its first push is rejected; Push
	// must merge and retry rather than fail.
	if err := laptop.Repo.Push(ctx); err != nil {
		t.Fatalf("push after rejection: %v", err)
	}
	files := git(t, remote, "ls-tree", "-r", "--name-only", "main")
	for _, want := range []string{"from-laptop.md", "from-desktop.md"} {
		if !strings.Contains(files, want) {
			t.Errorf("remote is missing %s:\n%s", want, files)
		}
	}
}

func TestSyncFinishesAnInterruptedMerge(t *testing.T) {
	noBackgroundPush(t)
	ctx := context.Background()
	remote := bareRemote(t)
	laptop := machine(t, remote, "laptop")
	desktop := machine(t, remote, "desktop")
	mustSync(t, laptop)
	mustSync(t, desktop)
	if _, _, err := laptop.Write(ctx, "Laptop", "", "a", nil, false); err != nil {
		t.Fatal(err)
	}
	mustSync(t, laptop)
	if _, _, err := desktop.Write(ctx, "Desktop", "", "b", nil, false); err != nil {
		t.Fatal(err)
	}
	// Leave the desktop mid-merge, as a sync killed during pull would.
	git(t, desktop.Store.Root, "pull", "-q", "--no-rebase", "--no-commit", "origin", "main")
	if _, err := os.Stat(filepath.Join(desktop.Store.Root, ".git", "MERGE_HEAD")); err != nil {
		t.Fatal("setup: expected an unfinished merge")
	}

	res := mustSync(t, desktop)
	if !res.Pushed {
		t.Fatalf("expected the recovered merge to be pushed: %+v", res)
	}
	mustSync(t, laptop)
	for _, a := range []*App{laptop, desktop} {
		for _, p := range []string{"laptop.md", "desktop.md"} {
			if !a.Store.Exists(p) {
				t.Errorf("%s is missing %s", a.host, p)
			}
		}
	}
}

func TestAutoSyncPullsInBackground(t *testing.T) {
	noBackgroundPush(t)
	ctx := context.Background()
	remote := bareRemote(t)
	laptop := machine(t, remote, "laptop")
	desktop := machine(t, remote, "desktop")
	desktop.StartAutoSync(50 * time.Millisecond)

	if _, _, err := laptop.Write(ctx, "Fresh idea", "", "- [idea] background sync works", nil, false); err != nil {
		t.Fatal(err)
	}
	mustSync(t, laptop)

	deadline := time.Now().Add(10 * time.Second)
	for {
		hits, err := desktop.Index.Search(index.Query{Text: "background"})
		if err != nil {
			t.Fatal(err)
		}
		if len(hits) == 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("desktop never picked up the laptop's note")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestRecencySurvivesPull(t *testing.T) {
	noBackgroundPush(t)
	ctx := context.Background()
	remote := bareRemote(t)
	laptop := machine(t, remote, "laptop")

	// A note written long ago, committed with its real date.
	note := "---\ntitle: Old decision\n---\n\n- [decision] chose SQLite\n"
	if err := os.WriteFile(filepath.Join(laptop.Store.Root, "old-decision.md"), []byte(note), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, laptop.Store.Root, "add", "old-decision.md")
	cmd := exec.Command("git", "-C", laptop.Store.Root, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-q", "-m", "old")
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE=2024-03-01T12:00:00Z", "GIT_COMMITTER_DATE=2024-03-01T12:00:00Z")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("commit: %v: %s", err, out)
	}
	mustSync(t, laptop)

	// A fresh machine pulls it today, after writing a note of its own.
	desktop := machine(t, remote, "desktop")
	if _, _, err := desktop.Write(ctx, "New note", "", "written today", nil, false); err != nil {
		t.Fatal(err)
	}
	mustSync(t, desktop)

	hits, err := desktop.Index.Recent(10)
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(hits); len(got) != 2 || got[0] != "new-note.md" {
		t.Fatalf("recent = %v, want the note written today first", got)
	}
	if y := hits[1].Modified.UTC().Year(); y != 2024 {
		t.Errorf("pulled note shows as updated in %d, want its commit year 2024", y)
	}
	old := desktop.mustSearch(t, index.Query{Before: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)})
	if len(old) != 1 || old[0].Path != "old-decision.md" {
		t.Errorf("date filter after pull = %v", paths(old))
	}

	// Editing a pulled file outside gitmind (uncommitted) makes it recent.
	if _, err := desktop.Store.Write(desktop.mustRead(t, "old-decision.md", "- [decision] still SQLite")); err != nil {
		t.Fatal(err)
	}
	if _, err := desktop.reindex(ctx); err != nil {
		t.Fatal(err)
	}
	if hits, _ := desktop.Index.Recent(1); hits[0].Path != "old-decision.md" {
		t.Errorf("locally edited note should be most recent, got %v", paths(hits))
	}
}

func paths(hits []index.Hit) []string {
	var out []string
	for _, h := range hits {
		out = append(out, h.Path)
	}
	return out
}

func (a *App) mustSearch(t *testing.T, q index.Query) []index.Hit {
	t.Helper()
	hits, err := a.Index.Search(q)
	if err != nil {
		t.Fatal(err)
	}
	return hits
}
