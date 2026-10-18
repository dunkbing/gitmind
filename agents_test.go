package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeAgents is a home directory with Claude Code and Codex "installed",
// and a claude CLI that records what it's asked to do.
func fakeAgents(t *testing.T, input string) (*agentSetup, *[]string, *bytes.Buffer) {
	home := t.TempDir()
	calls := &[]string{}
	added := false
	out := &bytes.Buffer{}
	a := &agentSetup{
		home: home, exe: "/opt/go bin/gitmind", in: bufio.NewReader(strings.NewReader(input)), out: out,
		interactive: true,
		lookPath:    func(name string) (string, error) { return "/usr/bin/" + name, nil },
		run: func(name string, args ...string) error {
			*calls = append(*calls, name+" "+strings.Join(args, " "))
			if strings.Join(args[:2], " ") == "mcp get" && !added {
				return errors.New("not found")
			}
			if strings.Join(args[:2], " ") == "mcp add" {
				added = true
			}
			return nil
		},
	}
	return a, calls, out
}

func write(t *testing.T, path, content string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	data, _ := os.ReadFile(path)
	return string(data)
}

func TestAgentSetup(t *testing.T) {
	// Yes to the Claude MCP server, hooks, CLAUDE.md and Codex's server; no to AGENTS.md.
	a, calls, out := fakeAgents(t, "\ny\nyes\n\nn\n")
	settings := filepath.Join(a.home, ".claude", "settings.json")
	existing := `{"model": "opus", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "fff notify"}]}]}, "permissions": {"allow": ["Bash(ls:*)"]}}`
	write(t, settings, existing)
	write(t, filepath.Join(a.home, ".claude", "CLAUDE.md"), "# Mine\n\nUse tabs.\n")
	write(t, filepath.Join(a.home, ".codex", "config.toml"), "model = \"gpt-5\"\n")
	write(t, filepath.Join(a.home, ".codex", "AGENTS.md"), "codex rules\n")

	if err := a.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if want := "claude mcp add --scope user gitmind -- /opt/go bin/gitmind"; !strings.Contains(strings.Join(*calls, "\n"), want) {
		t.Errorf("claude calls = %q, want %q", *calls, want)
	}

	var got map[string]any
	if err := json.Unmarshal([]byte(read(t, settings)), &got); err != nil {
		t.Fatalf("settings.json is no longer valid JSON: %v", err)
	}
	if got["model"] != "opus" || got["permissions"] == nil {
		t.Errorf("other settings were lost: %v", got)
	}
	s := read(t, settings)
	for _, want := range []string{`"fff notify"`, `"'/opt/go bin/gitmind' context"`, `"'/opt/go bin/gitmind' nudge"`, `"SessionStart"`} {
		if !strings.Contains(s, want) {
			t.Errorf("settings.json is missing %s:\n%s", want, s)
		}
	}
	if read(t, settings+".bak") != existing {
		t.Error("no backup of the original settings.json")
	}

	claudeMD := read(t, filepath.Join(a.home, ".claude", "CLAUDE.md"))
	if !strings.HasPrefix(claudeMD, "# Mine\n\nUse tabs.\n\n## Long-term memory (gitmind MCP)") {
		t.Errorf("CLAUDE.md:\n%s", claudeMD)
	}
	toml := read(t, filepath.Join(a.home, ".codex", "config.toml"))
	if toml != "model = \"gpt-5\"\n\n[mcp_servers.gitmind]\ncommand = \"/opt/go bin/gitmind\"\n" {
		t.Errorf("config.toml:\n%s", toml)
	}
	if read(t, filepath.Join(a.home, ".codex", "AGENTS.md")) != "codex rules\n" {
		t.Error("AGENTS.md changed although the answer was no")
	}

	// A second run finds everything in place, except what was declined, and
	// asks only about that.
	a.in = bufio.NewReader(strings.NewReader("n\n"))
	out.Reset()
	if err := a.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"already has the gitmind MCP server", "already has gitmind's hooks", "Claude Code already has gitmind's memory instructions", "Codex already has the gitmind MCP server"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("second run doesn't say %q:\n%s", want, out.String())
		}
	}
	if n := strings.Count(out.String(), "[Y/n]"); n != 1 {
		t.Errorf("second run asked %d questions, want 1 (the declined AGENTS.md):\n%s", n, out.String())
	}
}

func TestAgentSetupLeavesUnusualFilesAlone(t *testing.T) {
	a, _, out := fakeAgents(t, "")
	a.assumeYes = true
	a.lookPath = func(name string) (string, error) {
		if name == "claude" {
			return "/usr/bin/claude", nil
		}
		return "", errors.New("not found")
	}
	settings := filepath.Join(a.home, ".claude", "settings.json")
	commented := "{\n  // my settings\n  \"model\": \"opus\"\n}\n"
	write(t, settings, commented)
	if err := a.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if read(t, settings) != commented {
		t.Error("a settings.json with comments was rewritten")
	}
	if !strings.Contains(out.String(), "Skipping hooks") {
		t.Errorf("no explanation for skipping hooks:\n%s", out.String())
	}
	if _, err := os.Stat(filepath.Join(a.home, ".codex")); err == nil {
		t.Error("configured Codex although it isn't installed")
	}
}

func TestAgentSetupWithoutTerminal(t *testing.T) {
	a, calls, out := fakeAgents(t, "")
	a.interactive = false
	if err := a.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 || !strings.Contains(out.String(), "gitmind agents") {
		t.Errorf("without a terminal it should only print a hint; calls=%v out=%s", *calls, out.String())
	}
}
