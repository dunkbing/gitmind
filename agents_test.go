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
		run: func(name string, args ...string) (string, error) {
			*calls = append(*calls, name+" "+strings.Join(args, " "))
			switch strings.Join(args[:2], " ") {
			case "plugin list":
				return "", errors.New("unknown command 'plugin'") // a Claude Code without plugins
			case "mcp get":
				if !added {
					return "", errors.New("not found")
				}
			case "mcp add":
				added = true
			}
			return "", nil
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

// fakePluginAgents is fakeAgents with a Claude Code that has plugins, and
// optionally the MCP server an earlier setup added.
func fakePluginAgents(t *testing.T, input string, installed, oldMCP bool) (*agentSetup, *[]string, *bytes.Buffer) {
	a, calls, out := fakeAgents(t, input)
	a.lookPath = func(name string) (string, error) {
		if name == "codex" {
			return "", errors.New("not found")
		}
		if name == "gitmind" {
			return a.exe, nil
		}
		return "/usr/bin/" + name, nil
	}
	a.run = func(name string, args ...string) (string, error) {
		cmd := strings.Join(args, " ")
		*calls = append(*calls, name+" "+cmd)
		switch {
		case cmd == "plugin list --json" && installed:
			return `[{"id": "other@market"}, {"id": "gitmind@gitmind", "enabled": true}]`, nil
		case cmd == "plugin list --json":
			return `[{"id": "other@market"}]`, nil
		case strings.HasPrefix(cmd, "plugin install"):
			installed = true
		case cmd == "mcp get gitmind" && !oldMCP:
			return "", errors.New(`No MCP server named "gitmind"`)
		case strings.HasPrefix(cmd, "mcp remove"):
			oldMCP = false
		}
		return "", nil
	}
	return a, calls, out
}

func TestAgentSetupInstallsPluginAndRemovesOldSetup(t *testing.T) {
	a, calls, out := fakePluginAgents(t, "y\ny\n", false, true)
	settings := filepath.Join(a.home, ".claude", "settings.json")
	existing := `{"model": "opus", "hooks": {` +
		`"SessionStart": [{"hooks": [{"type": "command", "command": "'/opt/go bin/gitmind' context", "timeout": 30}]}],` +
		`"Stop": [{"hooks": [{"type": "command", "command": "fff notify"}, {"type": "command", "command": "gitmind nudge"}]}]}}`
	write(t, settings, existing)
	claudeMD := filepath.Join(a.home, ".claude", "CLAUDE.md")
	mine := "# Mine\n\nUse tabs.\n\n" + agentMemory + "\n## Later\n\nMore of mine.\n"
	write(t, claudeMD, mine)

	if err := a.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	all := strings.Join(*calls, "\n")
	for _, want := range []string{"claude plugin marketplace add dunkbing/gitmind", "claude plugin install gitmind@gitmind --scope user", "claude mcp remove --scope user gitmind"} {
		if !strings.Contains(all, want) {
			t.Errorf("claude calls don't include %q:\n%s", want, all)
		}
	}
	if strings.Contains(all, "mcp add") {
		t.Error("added the MCP server although the plugin brings it")
	}

	var got struct {
		Model string
		Hooks map[string][]map[string]any
	}
	if err := json.Unmarshal([]byte(read(t, settings)), &got); err != nil {
		t.Fatalf("settings.json is no longer valid JSON: %v", err)
	}
	if got.Model != "opus" {
		t.Errorf("other settings were lost: %s", read(t, settings))
	}
	if _, ok := got.Hooks["SessionStart"]; ok || len(got.Hooks["Stop"]) != 1 {
		t.Errorf("hooks = %v, want only fff's Stop hook", got.Hooks)
	}
	if s := read(t, settings); strings.Contains(s, "gitmind") || !strings.Contains(s, "fff notify") {
		t.Errorf("settings.json:\n%s", s)
	}
	if read(t, settings+".bak") != existing {
		t.Error("no backup of the original settings.json")
	}
	if md := read(t, claudeMD); md != "# Mine\n\nUse tabs.\n\n## Later\n\nMore of mine.\n" {
		t.Errorf("CLAUDE.md:\n%s", md)
	}
	if read(t, claudeMD+".bak") != mine {
		t.Error("no backup of the original CLAUDE.md")
	}

	// Run again: everything is in place, so nothing is asked.
	out.Reset()
	a.in = bufio.NewReader(strings.NewReader(""))
	if err := a.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "already has the gitmind plugin") || strings.Contains(out.String(), "[Y/n]") {
		t.Errorf("second run:\n%s", out.String())
	}
}

func TestAgentSetupKeepsOldSetupWhenDeclined(t *testing.T) {
	a, calls, out := fakePluginAgents(t, "n\n", true, true)
	if err := a.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(*calls, "\n"), "mcp remove") {
		t.Error("removed the MCP server although the answer was no")
	}
	if !strings.Contains(out.String(), "Remove what an earlier gitmind setup added to Claude Code (the gitmind MCP server)?") {
		t.Errorf("didn't offer to remove the old MCP server:\n%s", out.String())
	}
}

func TestWithoutAgentMemory(t *testing.T) {
	older := "## Long-term memory (gitmind MCP)\n\nAn older version.\n\n**Saving**\n- save things\n"
	for _, c := range []struct{ in, want string }{
		{agentMemory, ""},
		{"Mine.\n\n" + agentMemory, "Mine.\n"},
		{"Mine.\n\n" + older + "\n## Other\n\nAlso mine.\n", "Mine.\n\n## Other\n\nAlso mine.\n"},
		{older + "# Top\n", "# Top\n"},
	} {
		got, ok := withoutAgentMemory(c.in)
		if !ok || got != c.want {
			t.Errorf("withoutAgentMemory(%q) = %q, %v; want %q", c.in, got, ok, c.want)
		}
	}
	if _, ok := withoutAgentMemory("# Mine\n"); ok {
		t.Error("found gitmind's instructions in a file without them")
	}
}

// The plugin's memory skill is AGENT_MEMORY.md under a frontmatter, so the
// two can't drift apart.
func TestPluginSkillMatchesAgentMemory(t *testing.T) {
	// Windows checkouts may convert line endings.
	crlf := strings.NewReplacer("\r\n", "\n")
	skill := crlf.Replace(read(t, filepath.Join("plugin", "skills", "memory", "SKILL.md")))
	parts := strings.SplitN(skill, "\n---\n\n", 2)
	if len(parts) != 2 || !strings.HasPrefix(skill, "---\n") {
		t.Fatalf("SKILL.md has no frontmatter:\n%s", skill)
	}
	if parts[1] != agentMemory {
		t.Error("plugin/skills/memory/SKILL.md differs from AGENT_MEMORY.md; copy AGENT_MEMORY.md under its frontmatter")
	}
}
