package memory

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildContext(t *testing.T) {
	ctx := context.Background()
	a := machine(t, "", "laptop")
	write := func(title, dir, body string) {
		t.Helper()
		if _, _, err := a.Write(ctx, title, dir, body, nil, false); err != nil {
			t.Fatal(err)
		}
	}
	write("Auth service", "myapp", "- depends on [[Token store]]\n- see [[Rate limits]]")
	write("Token store", "myapp", "Redis cluster holding refresh tokens.\n- runs on [[Redis setup]]")
	write("Redis setup", "ops", "- [setup] Redis 7 with AOF")
	write("Login bug", "myapp", "- [gotcha] caused by [[Auth service]] clock skew")
	write("Unrelated", "", "nothing links here")

	out, err := a.BuildContext("Auth service", 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"# Auth service",
		"## Links to\n- depends on [[Token store]] (myapp/token-store.md): Redis cluster holding refresh tokens.",
		"## Linked from\n- [[Login bug]] (myapp/login-bug.md)",
		"## Links to notes that don't exist yet\n- [[Rate limits]]",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Redis setup") || strings.Contains(out, "Unrelated") {
		t.Errorf("depth 1 went too far:\n%s", out)
	}
	if out, _ = a.BuildContext("myapp/auth-service", 2); !strings.Contains(out, "## Two links away\n- [[Redis setup]] (ops/redis-setup.md), via [[Token store]]") {
		t.Errorf("depth 2 is missing Redis setup:\n%s", out)
	}

	// Renaming the link target's note away makes the link dangling again.
	if _, err := a.Delete(ctx, "Token store"); err != nil {
		t.Fatal(err)
	}
	if out, _ = a.BuildContext("Auth service", 1); !strings.Contains(out, "- [[Token store]]\n") {
		t.Errorf("deleted target should be listed as missing:\n%s", out)
	}
}

func TestSessionContext(t *testing.T) {
	ctx := context.Background()
	a := machine(t, "", "laptop")
	for _, n := range []struct{ title, dir, body string }{
		{"Deploy", "myapp", "- [setup] deploys go through CI"},
		{"Schema", "myapp", strings.Repeat("- [decision] long note line\n", 200)},
		{"Preferences", "general", "- [preference] use pnpm"},
		{"Other thing", "otherapp", "- [gotcha] unrelated"},
	} {
		if _, _, err := a.Write(ctx, n.title, n.dir, n.body, nil, false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := a.Pin(ctx, "Preferences", true); err != nil {
		t.Fatal(err)
	}

	out, err := a.SessionContext("myapp", 8000)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`Current project: "myapp"`,
		"## Pinned notes\n\n### Preferences (general/preferences.md)\n- [preference] use pnpm",
		"## Project notes (myapp)\n- Schema (myapp/schema.md, ",
		"): - [setup] deploys go through CI\n",
		"## Recently updated elsewhere\n- Other thing (otherapp/other-thing.md, ",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	// Unpinned notes appear as index lines, not in full.
	if strings.Count(out, "long note line") != 1 {
		t.Errorf("unpinned note body was included:\n%s", out)
	}
	// The pinned note isn't listed again, and its section, now empty, is left out.
	if strings.Count(out, "general/preferences.md") != 1 || strings.Contains(out, "## General notes") {
		t.Errorf("pinned note listed twice, or empty section:\n%s", out)
	}

	// Many notes: the index stops at the budget and says what's left.
	for i := range 60 {
		if _, _, err := a.Write(ctx, fmt.Sprintf("Note %02d", i), "myapp", "- [setup] some fact about the system that takes a line", nil, false); err != nil {
			t.Fatal(err)
		}
	}
	out, _ = a.SessionContext("myapp", 3000)
	if len(out) > 3300 || !strings.Contains(out, `more (list_notes directory "myapp")`) {
		t.Errorf("budget not respected (%d bytes):\n%s", len(out), out)
	}

	empty := machine(t, "", "fresh")
	if out, _ := empty.SessionContext("myapp", 8000); !strings.Contains(out, "Memory is empty") {
		t.Errorf("empty memory: %s", out)
	}
}

func TestLockedNotesAndPinning(t *testing.T) {
	ctx := context.Background()
	a := machine(t, "", "laptop")
	if _, _, err := a.Write(ctx, "House rules", "general", "- [instruction] never force-push main", nil, false); err != nil {
		t.Fatal(err)
	}
	// The user locks the note by hand.
	n, _, _ := a.Store.Read("general/house-rules.md")
	n.Locked = true
	if _, err := a.Store.Write(n); err != nil {
		t.Fatal(err)
	}

	checks := map[string]error{}
	_, checks["edit"] = a.Edit(ctx, "House rules", EditOp{Operation: "append", Content: "- more"})
	_, _, checks["overwrite"] = a.Write(ctx, "House rules", "general", "replaced", nil, true)
	_, _, checks["move"] = a.Move(ctx, "House rules", nil, "Rules")
	_, checks["pin"] = a.Pin(ctx, "House rules", true)
	_, checks["delete"] = a.Delete(ctx, "House rules")
	for op, err := range checks {
		if err == nil || !strings.Contains(err.Error(), "locked") {
			t.Errorf("%s on a locked note: %v", op, err)
		}
	}
	if got, _, _ := a.Store.Read("general/house-rules.md"); got.Body != "- [instruction] never force-push main\n" {
		t.Errorf("locked note changed: %q", got.Body)
	}

	// Overwriting keeps the pin.
	if _, _, err := a.Write(ctx, "Editor", "general", "vim", nil, false); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Pin(ctx, "Editor", true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.Write(ctx, "Editor", "general", "helix", nil, true); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := a.Store.Read("general/editor.md"); !got.Pinned {
		t.Error("overwrite dropped the pin")
	}
}

func TestSimilarNotes(t *testing.T) {
	ctx := context.Background()
	a := machine(t, "", "laptop")
	for _, title := range []string{"Redis cluster setup", "Postgres backups", "Notes about the team"} {
		if _, _, err := a.Write(ctx, title, "ops", "- [setup] something", nil, false); err != nil {
			t.Fatal(err)
		}
	}
	rel, _, err := a.Write(ctx, "Redis eviction policy", "ops", "- [decision] allkeys-lru", []string{"cache"}, false)
	if err != nil {
		t.Fatal(err)
	}
	similar, err := a.Similar(rel, 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(similar) != 1 || similar[0].Path != "ops/redis-cluster-setup.md" {
		t.Errorf("Similar = %+v, want only the other Redis note", similar)
	}
	// Stop words alone don't make notes similar.
	rel, _, _ = a.Write(ctx, "Notes about the release", "ops", "x", nil, false)
	if similar, _ := a.Similar(rel, 3); len(similar) != 0 {
		t.Errorf("stop words matched: %+v", similar)
	}
}

func TestProjectName(t *testing.T) {
	root := filepath.Join(t.TempDir(), "My Repo")
	for _, args := range [][]string{
		{"init", "-q", "-b", "main", root},
		{"-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"},
		{"-C", root, "worktree", "add", "-q", filepath.Join(root, "..", "feature-wt")},
	} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "sub", "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	for cwd, want := range map[string]string{
		root:                                       "my-repo",
		filepath.Join(root, "sub", "dir"):          "my-repo",
		filepath.Join(root, "..", "feature-wt"):    "my-repo",
		filepath.Join(t.TempDir(), "Plain Folder"): "plain-folder",
		"": "",
	} {
		if got := ProjectName(cwd); got != want {
			t.Errorf("ProjectName(%q) = %q, want %q", cwd, got, want)
		}
	}
}
