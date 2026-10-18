package main

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// agentMemory is the standing instruction for agents (AGENT_MEMORY.md),
// added to CLAUDE.md and AGENTS.md. Its first line marks it as present.
//
//go:embed AGENT_MEMORY.md
var agentMemory string

// agentSetup adds gitmind to the coding agents installed on this machine:
// Claude Code (MCP server, hooks, instructions) and Codex (MCP server,
// instructions). Every change is asked for first and skipped when it's
// already in place.
type agentSetup struct {
	home        string
	exe         string // absolute path of this gitmind binary
	in          *bufio.Reader
	out         io.Writer
	assumeYes   bool // answer yes to everything (--yes)
	interactive bool
	lookPath    func(string) (string, error)
	run         func(name string, args ...string) error
}

func newAgentSetup(assumeYes bool) (*agentSetup, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return &agentSetup{
		home: home, exe: exe, in: stdin, out: os.Stdout,
		assumeYes: assumeYes, interactive: isTerminal(),
		lookPath: exec.LookPath,
		run: func(name string, args ...string) error {
			out, err := exec.Command(name, args...).CombinedOutput()
			if err != nil {
				return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
			}
			return nil
		},
	}, nil
}

func (a *agentSetup) Run(ctx context.Context) error {
	if !a.assumeYes && !a.interactive {
		fmt.Fprintln(a.out, "\nTo add gitmind to Claude Code and Codex, run `gitmind agents` in a terminal (or `gitmind agents --yes`).")
		return nil
	}
	claude := a.has("claude", ".claude")
	codex := a.has("codex", ".codex")
	if !claude && !codex {
		fmt.Fprintln(a.out, "\nNo Claude Code or Codex found on this machine. After installing one, run `gitmind agents`.")
		return nil
	}
	fmt.Fprintln(a.out)
	if claude {
		if err := a.claudeMCP(ctx); err != nil {
			return err
		}
		if err := a.claudeHooks(ctx); err != nil {
			return err
		}
		if err := a.instructions(ctx, "Claude Code", filepath.Join(a.home, ".claude", "CLAUDE.md")); err != nil {
			return err
		}
	}
	if codex {
		if err := a.codexMCP(ctx); err != nil {
			return err
		}
		if err := a.instructions(ctx, "Codex", filepath.Join(a.home, ".codex", "AGENTS.md")); err != nil {
			return err
		}
	}
	return nil
}

// has reports whether an agent is installed: its CLI is on PATH or its
// config directory exists.
func (a *agentSetup) has(cli, dir string) bool {
	if _, err := a.lookPath(cli); err == nil {
		return true
	}
	_, err := os.Stat(filepath.Join(a.home, dir))
	return err == nil
}

func (a *agentSetup) claudeMCP(ctx context.Context) error {
	if _, err := a.lookPath("claude"); err != nil {
		fmt.Fprintf(a.out, "• Claude Code's CLI isn't on PATH; add gitmind yourself with:\n    claude mcp add --scope user gitmind -- %s\n", shellQuote(a.exe))
		return nil
	}
	if a.run("claude", "mcp", "get", "gitmind") == nil {
		fmt.Fprintln(a.out, "✓ Claude Code already has the gitmind MCP server")
		return nil
	}
	ok, err := a.ask(ctx, "Add gitmind to Claude Code as an MCP server (all projects)?")
	if err != nil || !ok {
		return err
	}
	if err := a.run("claude", "mcp", "add", "--scope", "user", "gitmind", "--", a.exe); err != nil {
		fmt.Fprintf(a.out, "✗ couldn't add it: %v\n", err)
		return nil
	}
	fmt.Fprintln(a.out, "✓ Added gitmind to Claude Code")
	return nil
}

// claudeHooks adds the SessionStart (recall) and Stop (save nudge) hooks to
// ~/.claude/settings.json, keeping everything else in the file.
func (a *agentSetup) claudeHooks(ctx context.Context) error {
	path := filepath.Join(a.home, ".claude", "settings.json")
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	root := map[string]json.RawMessage{}
	if len(strings.TrimSpace(string(data))) > 0 {
		if err := json.Unmarshal(data, &root); err != nil {
			fmt.Fprintf(a.out, "• Skipping hooks: %s isn't plain JSON (%v). See https://gitmind.app/docs/cli/ to add them by hand.\n", path, err)
			return nil
		}
	}
	hooks := map[string][]map[string]any{}
	if raw, ok := root["hooks"]; ok {
		if err := json.Unmarshal(raw, &hooks); err != nil {
			fmt.Fprintf(a.out, "• Skipping hooks: the hooks in %s have an unexpected shape.\n", path)
			return nil
		}
	}
	want := []struct {
		event, sub string
		timeout    int
	}{{"SessionStart", "context", 30}, {"Stop", "nudge", 10}}
	var missing []string
	for _, w := range want {
		if !hasHook(hooks[w.event], "gitmind", w.sub) {
			missing = append(missing, w.event)
		}
	}
	if len(missing) == 0 {
		fmt.Fprintln(a.out, "✓ Claude Code already has gitmind's hooks")
		return nil
	}
	ok, err := a.ask(ctx, "Add Claude Code hooks that load your notes when a session starts and remind the agent to save before it stops?")
	if err != nil || !ok {
		return err
	}
	for _, w := range want {
		if hasHook(hooks[w.event], "gitmind", w.sub) {
			continue
		}
		hooks[w.event] = append(hooks[w.event], map[string]any{
			"hooks": []map[string]any{{"type": "command", "command": shellQuote(a.exe) + " " + w.sub, "timeout": w.timeout}},
		})
	}
	raw, err := json.Marshal(hooks)
	if err != nil {
		return err
	}
	root["hooks"] = raw
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	if len(data) > 0 {
		if err := os.WriteFile(path+".bak", data, 0o644); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
		return err
	}
	backup := ""
	if len(data) > 0 {
		backup = " (backup: settings.json.bak)"
	}
	fmt.Fprintf(a.out, "✓ Added hooks to %s%s\n", path, backup)
	return nil
}

func hasHook(groups []map[string]any, words ...string) bool {
	for _, g := range groups {
		list, _ := g["hooks"].([]any)
		for _, h := range list {
			m, _ := h.(map[string]any)
			cmd, _ := m["command"].(string)
			found := true
			for _, w := range words {
				found = found && strings.Contains(cmd, w)
			}
			if found {
				return true
			}
		}
	}
	return false
}

func (a *agentSetup) codexMCP(ctx context.Context) error {
	path := filepath.Join(a.home, ".codex", "config.toml")
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if strings.Contains(string(data), "[mcp_servers.gitmind]") {
		fmt.Fprintln(a.out, "✓ Codex already has the gitmind MCP server")
		return nil
	}
	ok, err := a.ask(ctx, "Add gitmind to Codex as an MCP server?")
	if err != nil || !ok {
		return err
	}
	section := fmt.Sprintf("[mcp_servers.gitmind]\ncommand = %q\n", a.exe)
	if len(data) > 0 {
		section = strings.TrimRight(string(data), "\n") + "\n\n" + section
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(section), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(a.out, "✓ Added gitmind to %s\n", path)
	return nil
}

// instructions appends AGENT_MEMORY.md to an agent's global instructions
// file, so it knows when to search and save.
func (a *agentSetup) instructions(ctx context.Context, agent, path string) error {
	marker := strings.SplitN(agentMemory, "\n", 2)[0]
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if strings.Contains(string(data), marker) {
		fmt.Fprintf(a.out, "✓ %s already has gitmind's memory instructions\n", agent)
		return nil
	}
	ok, err := a.ask(ctx, fmt.Sprintf("Add instructions to %s telling %s when to search and save memory?", tildePath(a.home, path), agent))
	if err != nil || !ok {
		return err
	}
	content := agentMemory
	if len(data) > 0 {
		content = strings.TrimRight(string(data), "\n") + "\n\n" + agentMemory
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(a.out, "✓ Added memory instructions to %s\n", tildePath(a.home, path))
	return nil
}

// ask asks a yes/no question, defaulting to yes.
func (a *agentSetup) ask(ctx context.Context, question string) (bool, error) {
	if a.assumeYes {
		return true, nil
	}
	for {
		fmt.Fprintf(a.out, "%s [Y/n] ", question)
		answer, err := readLine(ctx, a.in)
		if err != nil {
			return false, err
		}
		switch strings.ToLower(answer) {
		case "", "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		}
	}
}

func shellQuote(s string) string {
	if strings.ContainsAny(s, " '\"$`\\") {
		return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
	}
	return s
}

func tildePath(home, path string) string {
	if rel, err := filepath.Rel(home, path); err == nil && !strings.HasPrefix(rel, "..") {
		return "~/" + rel
	}
	return path
}
