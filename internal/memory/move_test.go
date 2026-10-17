package memory

import (
	"context"
	"strings"
	"testing"
)

func TestMoveKeepsLinksWorking(t *testing.T) {
	noBackgroundPush(t)
	ctx := context.Background()
	a := machine(t, "", "laptop")
	write := func(title, dir, body string) {
		t.Helper()
		if _, _, err := a.Write(ctx, title, dir, body, nil, false); err != nil {
			t.Fatal(err)
		}
	}
	write("Auth service", "myapp", "Handles login. See also [[Auth service#Tokens]].\n\n## Tokens\n\nJWT")
	write("Login bug", "myapp", "- caused by [[Auth service]]\n- details in [[Auth service#Tokens|token docs]]\n- path link [[myapp/auth-service]]\n```\n[[Auth service]] in code\n```")
	write("Unrelated", "", "mentions [[Billing]] only")

	// Moving to another directory: title links still resolve by name, so
	// only the path link changes.
	dir := "platform"
	to, updated, err := a.Move(ctx, "Auth service", &dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if to != "platform/auth-service.md" || len(updated) != 1 || updated[0] != "myapp/login-bug.md" {
		t.Fatalf("Move = %q, %v", to, updated)
	}
	bug, _, _ := a.Store.Read("myapp/login-bug.md")
	if !strings.Contains(bug.Body, "[[platform/auth-service]]") || !strings.Contains(bug.Body, "caused by [[Auth service]]") {
		t.Fatalf("after directory move:\n%s", bug.Body)
	}
	if a.Store.Exists("myapp/auth-service.md") {
		t.Fatal("old file still exists")
	}

	// Renaming rewrites title links (keeping #heading and |alias) and the
	// note's own self-link, but not links inside code blocks.
	to, updated, err = a.Move(ctx, "platform/auth-service", nil, "Identity service")
	if err != nil {
		t.Fatal(err)
	}
	if to != "platform/identity-service.md" || len(updated) != 1 {
		t.Fatalf("rename = %q, %v", to, updated)
	}
	bug, _, _ = a.Store.Read("myapp/login-bug.md")
	for _, want := range []string{
		"caused by [[Identity service]]",
		"[[Identity service#Tokens|token docs]]",
		"[[platform/identity-service]]",
		"[[Auth service]] in code",
	} {
		if !strings.Contains(bug.Body, want) {
			t.Errorf("login bug is missing %q:\n%s", want, bug.Body)
		}
	}
	self, _, _ := a.Store.Read(to)
	if self.Title != "Identity service" || !strings.Contains(self.Body, "[[Identity service#Tokens]]") {
		t.Errorf("renamed note: %q\n%s", self.Title, self.Body)
	}
	if out, _ := a.BuildContext("Login bug", 1); strings.Contains(out, "don't exist yet") {
		t.Errorf("links broke after the move:\n%s", out)
	}

	// git sees a rename, so the note's history follows it.
	if log := git(t, a.Store.Root, "log", "--follow", "--format=%s", "--", to); !strings.Contains(log, "memory: add myapp/auth-service.md") {
		t.Errorf("history lost across moves:\n%s", log)
	}
	if status := git(t, a.Store.Root, "status", "--porcelain"); status != "" {
		t.Errorf("uncommitted changes:\n%s", status)
	}

	// Refusals: collisions and no-op moves.
	myapp := "myapp"
	if _, _, err := a.Move(ctx, "Unrelated", &myapp, "Login bug"); err == nil {
		t.Error("move onto an existing note succeeded")
	}
	if _, _, err := a.Move(ctx, "Unrelated", nil, "Unrelated"); err == nil {
		t.Error("no-op move succeeded")
	}
	if !a.Store.Exists("unrelated.md") {
		t.Error("a refused move changed the note")
	}
}

func TestReplaceSectionEdit(t *testing.T) {
	ctx := context.Background()
	a := machine(t, "", "laptop")
	if _, _, err := a.Write(ctx, "Runbook", "", "## Deploy\n\nold steps\n\n## Rollback\n\nkeep", nil, false); err != nil {
		t.Fatal(err)
	}
	res, err := a.Edit(ctx, "Runbook", EditOp{Operation: "replace_section", Section: "Deploy", Content: "- [setup] new steps"})
	if err != nil || res.AddedSection {
		t.Fatalf("replace: %+v, %v", res, err)
	}
	res, err = a.Edit(ctx, "Runbook", EditOp{Operation: "replace_section", Section: "Monitoring", Content: "- dashboards"})
	if err != nil || !res.AddedSection {
		t.Fatalf("add: %+v, %v", res, err)
	}
	n, _, _ := a.Store.Read("runbook.md")
	want := "## Deploy\n\n- [setup] new steps\n\n## Rollback\n\nkeep\n\n## Monitoring\n\n- dashboards\n"
	if n.Body != want {
		t.Errorf("body:\n%q\nwant\n%q", n.Body, want)
	}
}
