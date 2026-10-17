package memory

import (
	"context"
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

	out, err := a.SessionContext("myapp", 100000)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`Current project: "myapp"`,
		"### Deploy (myapp/deploy.md)\n- [setup] deploys go through CI",
		"(truncated; read_note myapp/schema.md for the rest)",
		"### Preferences (general/preferences.md)\n- [preference] use pnpm",
		"## Recently updated elsewhere\n- Other thing (otherapp/other-thing.md",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}

	// A tight budget lists notes by title instead of dropping them.
	small, _ := a.SessionContext("myapp", 600)
	if !strings.Contains(small, "More notes (use read_note):") || !strings.Contains(small, "general/preferences.md") {
		t.Errorf("tight budget should still name every note:\n%s", small)
	}
	if len(small) > 1500 {
		t.Errorf("tight budget ignored: %d bytes", len(small))
	}

	empty := machine(t, "", "fresh")
	if out, _ := empty.SessionContext("myapp", 8000); !strings.Contains(out, "Memory is empty") {
		t.Errorf("empty memory: %s", out)
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
