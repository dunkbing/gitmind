package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dunkbing/gitmind/internal/claudecode"
	"github.com/dunkbing/gitmind/internal/gitsync"
)

func TestImportClaudeCode(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "notes")
	if err := gitsync.Init(ctx, dir, "", "user.name=test", "user.email=test@test"); err != nil {
		t.Fatal(err)
	}
	mems := []claudecode.Memory{
		{Project: "shop", Name: "deploy", Title: "Deploy steps", Description: "Deploy with make ship", Type: "project", Body: "Run it after tests."},
		{Project: "general", Name: "style", Title: "Commit style", Description: "One-line commits", Type: "feedback", Body: "No trailers."},
		{Project: "general", Name: "key", Title: "API key", Description: "The key", Type: "reference", Body: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD"},
	}
	var out bytes.Buffer
	asked := ""
	ask := func(q string) (bool, error) { asked = q; return true, nil }
	if err := importClaudeCode(ctx, dir, mems, &out, ask, false); err != nil {
		t.Fatal(err)
	}
	if asked == "" {
		t.Error("imported without asking")
	}
	for _, p := range []string{"shop/deploy-steps.md", "general/commit-style.md"} {
		if _, err := os.Stat(filepath.Join(dir, p)); err != nil {
			t.Errorf("%s not written: %v", p, err)
		}
	}
	if !strings.Contains(out.String(), "Imported 2 memories; skipped 1") || !strings.Contains(out.String(), "secret") {
		t.Errorf("output:\n%s", out.String())
	}
	log, _ := exec.Command("git", "-C", dir, "log", "--format=%s").Output()
	if got := strings.Split(strings.TrimSpace(string(log)), "\n")[0]; !strings.HasPrefix(got, "gitmind: import 2 notes from Claude Code") {
		t.Errorf("last commit = %q, want one import commit (not a memory: change for review)", got)
	}

	// Importing again skips what's there.
	out.Reset()
	if err := importClaudeCode(ctx, dir, mems[:2], &out, nil, false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Imported 0 memories; skipped 2") {
		t.Errorf("second import:\n%s", out.String())
	}
}
