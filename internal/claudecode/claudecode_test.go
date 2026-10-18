package claudecode

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// slug names a project's directory the way Claude Code does.
func slug(p string) string { return strings.NewReplacer("/", "-", `\`, "-", ":", "-").Replace(p) }

func TestProjectDir(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home", "me")
	for _, d := range []string{"code/my-app", "code/my/other", "agent-memory"} {
		os.MkdirAll(filepath.Join(home, d), 0o755)
	}
	for in, want := range map[string]string{
		slug(home):                        "general",
		slug(home + "/code/my-app"):       "my-app", // a dash in the name, not a directory
		slug(home + "/code/my/other"):     "other",
		slug(home + "/agent-memory"):      "agent-memory",
		slug(home + "/deleted-project-x"): "deleted-project-x",
	} {
		if got := ProjectDir(in, home); got != want {
			t.Errorf("ProjectDir(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFindAndConvert(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "home", "me")
	os.MkdirAll(filepath.Join(home, "code", "shop"), 0o755)
	cfg := filepath.Join(home, ".claude")
	mem := filepath.Join(cfg, "projects", slug(filepath.Join(home, "code", "shop")), "memory")
	write(t, filepath.Join(mem, "MEMORY.md"), "- [Deploy steps](deploy-steps.md) — how to ship\n- [JS package manager](js-pm.md) — bun\n")
	write(t, filepath.Join(mem, "deploy-steps.md"), "---\nname: deploy-steps\ndescription: Deploy with make ship after tests pass\nmetadata:\n  type: project\n  modified: 2026-10-01T10:00:00Z\n---\n\nRun `make ship`. See [[js-pm]].\n")
	write(t, filepath.Join(mem, "js-pm.md"), "---\nname: js-pm\ndescription: \"Use bun, not npm\"\ntype: feedback\n---\n\n**Why:** npm crashed.\n")
	write(t, filepath.Join(mem, "who.md"), "---\nname: who-i-am\ndescription: Backend developer, new to React\nmetadata:\n  type: user\n---\n\nExplain frontend ideas in backend terms.\n")

	mems, err := Find(cfg, home)
	if err != nil {
		t.Fatal(err)
	}
	if len(mems) != 3 {
		t.Fatalf("found %d memories, want 3 (MEMORY.md is the index)", len(mems))
	}
	got := map[string]string{}
	for _, n := range Notes(mems) {
		got[n.Path] = string(n.Format())
	}
	deploy := got["shop/deploy-steps.md"]
	for _, want := range []string{"title: Deploy steps", "tags: [claude-code, project]", "created: 2026-10-01T10:00:00Z", "- [project] Deploy with make ship after tests pass", "See [[JS package manager]]."} {
		if !strings.Contains(deploy, want) {
			t.Errorf("deploy note lacks %q:\n%s", want, deploy)
		}
	}
	if !strings.Contains(got["shop/js-package-manager.md"], "- [instruction] Use bun, not npm") {
		t.Errorf("feedback note:\n%s", got["shop/js-package-manager.md"])
	}
	// What Claude Code knows about the user applies everywhere.
	if !strings.Contains(got["general/who-i-am.md"], "- [preference] Backend developer, new to React") {
		t.Errorf("user note: %v", got)
	}
}
