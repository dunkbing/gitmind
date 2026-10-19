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

	"github.com/dunkbing/gitmind/internal/claudecode"
	"github.com/dunkbing/gitmind/internal/gitsync"
)

// agentMemory is the standing instruction for agents (AGENT_MEMORY.md),
// added to CLAUDE.md and AGENTS.md. Its first line marks it as present.
// Windows checkouts may give the file CRLF line endings.
var agentMemory = strings.ReplaceAll(agentMemoryFile, "\r\n", "\n")

//go:embed AGENT_MEMORY.md
var agentMemoryFile string

// pluginMarketplace is the GitHub repository whose marketplace holds
// gitmind's Claude Code plugin (plugin/), installed as pluginID.
const (
	pluginMarketplace = "dunkbing/gitmind"
	pluginID          = "gitmind@gitmind"
)

// agentSetup adds gitmind to the coding agents installed on this machine:
// Claude Code (the plugin, or for a CLI without plugins the MCP server, hooks
// and instructions) and Codex (MCP server, instructions). Every change is
// asked for first and skipped when it's already in place.
type agentSetup struct {
	home        string
	dir         string // the notes repository, to import Claude Code's memories into
	exe         string // absolute path of this gitmind binary
	in          *bufio.Reader
	out         io.Writer
	assumeYes   bool // answer yes to everything (--yes)
	interactive bool
	lookPath    func(string) (string, error)
	run         func(name string, args ...string) (string, error) // returns stdout
}

func newAgentSetup(dir string, assumeYes bool) (*agentSetup, error) {
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
		home: home, dir: dir, exe: exe, in: stdin, out: os.Stdout,
		assumeYes: assumeYes, interactive: isTerminal(),
		lookPath: exec.LookPath,
		run: func(name string, args ...string) (string, error) {
			cmd := exec.Command(name, args...)
			var stderr strings.Builder
			cmd.Stderr = &stderr
			out, err := cmd.Output()
			if err != nil {
				msg := strings.TrimSpace(stderr.String() + "\n" + string(out))
				return "", fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, msg)
			}
			return string(out), nil
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
		if err := a.claude(ctx); err != nil {
			return err
		}
	}
	if codex {
		if err := a.codex(ctx); err != nil {
			return err
		}
	}
	fmt.Fprintln(a.out, "\nTo check it works, restart your agent in a project and ask it: \"What do you remember about this project?\"")
	return nil
}

func (a *agentSetup) codex(ctx context.Context) error {
	if list, ok := a.codexPlugins(); ok {
		return a.codexPlugin(ctx, list)
	}
	if err := a.codexMCP(ctx); err != nil {
		return err
	}
	return a.instructions(ctx, "Codex", a.agentsMD())
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

func (a *agentSetup) claude(ctx context.Context) error {
	if list, ok := a.claudePlugins(); ok {
		if err := a.claudePlugin(ctx, list); err != nil {
			return err
		}
	} else {
		if err := a.claudeMCP(ctx); err != nil {
			return err
		}
		if err := a.claudeHooks(ctx); err != nil {
			return err
		}
		if err := a.instructions(ctx, "Claude Code", a.claudeMD()); err != nil {
			return err
		}
	}
	return a.claudeMemories(ctx)
}

func (a *agentSetup) claudeMD() string { return filepath.Join(a.home, ".claude", "CLAUDE.md") }
func (a *agentSetup) claudeSettings() string {
	return filepath.Join(a.home, ".claude", "settings.json")
}

// claudePlugins lists Claude Code's installed plugins as JSON; ok is false
// when its CLI isn't on PATH or predates plugins.
func (a *agentSetup) claudePlugins() (list string, ok bool) {
	if _, err := a.lookPath("claude"); err != nil {
		return "", false
	}
	list, err := a.run("claude", "plugin", "list", "--json")
	return list, err == nil
}

// claudePlugin installs gitmind's Claude Code plugin, which bundles the MCP
// server, both hooks and the memory instructions (as a skill), then offers
// to remove what earlier versions of setup wrote into Claude Code's files.
func (a *agentSetup) claudePlugin(ctx context.Context, list string) error {
	var installed []struct {
		ID string `json:"id"`
	}
	json.Unmarshal([]byte(list), &installed)
	has := false
	for _, p := range installed {
		has = has || p.ID == pluginID
	}
	if has {
		fmt.Fprintln(a.out, "✓ Claude Code already has the gitmind plugin")
	} else {
		ok, err := a.ask(ctx, "Install the gitmind plugin for Claude Code (all projects)? It loads your notes when a session starts and reminds Claude to save before it stops.")
		if err != nil || !ok {
			return err
		}
		// Two steps rather than install --marketplace, which needs Claude Code 2.1.275.
		if _, err := a.run("claude", "plugin", "marketplace", "add", pluginMarketplace); err != nil {
			fmt.Fprintf(a.out, "✗ couldn't add gitmind's plugin marketplace: %v\n", err)
			return nil
		}
		if _, err := a.run("claude", "plugin", "install", pluginID, "--scope", "user"); err != nil {
			fmt.Fprintf(a.out, "✗ couldn't install the plugin: %v\n", err)
			return nil
		}
		fmt.Fprintln(a.out, "✓ Installed the gitmind plugin for Claude Code")
	}
	a.checkPath()
	return a.removeOldClaudeSetup(ctx)
}

// checkPath warns when the plugins, which run `gitmind` from PATH (unlike
// the old setup's absolute path), won't find this binary.
func (a *agentSetup) checkPath() {
	if path, err := a.lookPath("gitmind"); err != nil {
		fmt.Fprintf(a.out, "• gitmind isn't on your PATH, so the plugin can't start it. Add %s to PATH.\n", filepath.Dir(a.exe))
	} else if resolved, err := filepath.EvalSymlinks(path); err == nil && resolved != a.exe {
		fmt.Fprintf(a.out, "• The plugin will run %s, not this gitmind (%s).\n", path, a.exe)
	}
}

func (a *agentSetup) codexConfig() string { return filepath.Join(a.home, ".codex", "config.toml") }
func (a *agentSetup) agentsMD() string    { return filepath.Join(a.home, ".codex", "AGENTS.md") }

// codexPlugins lists Codex's plugins as JSON; ok is false when its CLI
// isn't on PATH or predates plugins.
func (a *agentSetup) codexPlugins() (list string, ok bool) {
	if _, err := a.lookPath("codex"); err != nil {
		return "", false
	}
	list, err := a.run("codex", "plugin", "list", "--json")
	return list, err == nil
}

// codexPlugin installs gitmind's Codex plugin (MCP server, session-start
// hook, memory skill), then offers to remove what earlier versions of setup
// wrote into Codex's files.
func (a *agentSetup) codexPlugin(ctx context.Context, list string) error {
	var plugins struct {
		Installed []struct {
			ID string `json:"pluginId"`
		} `json:"installed"`
	}
	json.Unmarshal([]byte(list), &plugins)
	has := false
	for _, p := range plugins.Installed {
		has = has || p.ID == pluginID
	}
	if has {
		fmt.Fprintln(a.out, "✓ Codex already has the gitmind plugin")
	} else {
		ok, err := a.ask(ctx, "Install the gitmind plugin for Codex? It loads your notes when a session starts.")
		if err != nil || !ok {
			return err
		}
		if _, err := a.run("codex", "plugin", "marketplace", "add", pluginMarketplace); err != nil {
			fmt.Fprintf(a.out, "✗ couldn't add gitmind's plugin marketplace to Codex: %v\n", err)
			return nil
		}
		if _, err := a.run("codex", "plugin", "add", pluginID); err != nil {
			fmt.Fprintf(a.out, "✗ couldn't install the Codex plugin: %v\n", err)
			return nil
		}
		fmt.Fprintln(a.out, "✓ Installed the gitmind plugin for Codex. In Codex, open /hooks once to trust its session-start hook.")
	}
	a.checkPath()
	return a.removeOldCodexSetup(ctx)
}

// removeOldCodexSetup offers to remove the MCP server and AGENTS.md block
// that setup added before the plugin existed; the server would clash with
// the plugin's, which has the same name.
func (a *agentSetup) removeOldCodexSetup(ctx context.Context) error {
	var found []string
	config := a.codexConfig()
	toml, err := os.ReadFile(config)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	newTOML, inTOML := withoutTOMLTable(string(toml), "mcp_servers.gitmind")
	if inTOML {
		found = append(found, "the gitmind MCP server in "+tildePath(a.home, config))
	}
	agentsMD := a.agentsMD()
	md, err := os.ReadFile(agentsMD)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	newMD, inMD := withoutAgentMemory(string(md))
	if inMD {
		found = append(found, "memory instructions in "+tildePath(a.home, agentsMD))
	}
	if len(found) == 0 {
		return nil
	}
	ok, err := a.ask(ctx, fmt.Sprintf("Remove what an earlier gitmind setup added to Codex (%s)? The plugin replaces it.", joinList(found)))
	if err != nil || !ok {
		return err
	}
	for _, f := range []struct {
		path, content, label string
		found                bool
		old                  []byte
	}{{config, newTOML, "the gitmind MCP server from", inTOML, toml}, {agentsMD, newMD, "gitmind's memory instructions from", inMD, md}} {
		if !f.found {
			continue
		}
		if err := os.WriteFile(f.path+".bak", f.old, 0o644); err != nil {
			return err
		}
		if err := os.WriteFile(f.path, []byte(f.content), 0o644); err != nil {
			return err
		}
		fmt.Fprintf(a.out, "✓ Removed %s %s (backup: %s.bak)\n", f.label, tildePath(a.home, f.path), filepath.Base(f.path))
	}
	return nil
}

// withoutTOMLTable removes the table [name] and its subtables ([name.x])
// from a TOML file, up to the next other table.
func withoutTOMLTable(toml, name string) (string, bool) {
	var out []string
	skipping, found := false, false
	for _, line := range strings.Split(toml, "\n") {
		if t := strings.TrimSpace(line); strings.HasPrefix(t, "[") {
			header := strings.Trim(t, "[] ")
			skipping = header == name || strings.HasPrefix(header, name+".")
			found = found || skipping
		}
		if !skipping {
			out = append(out, line)
		}
	}
	if !found {
		return toml, false
	}
	s := strings.TrimRight(strings.Join(out, "\n"), "\n")
	if s != "" {
		s += "\n"
	}
	return s, true
}

// removeOldClaudeSetup offers to remove the MCP server, hooks and CLAUDE.md
// block that setup added before the plugin existed; keeping them alongside
// the plugin would load the notes twice.
func (a *agentSetup) removeOldClaudeSetup(ctx context.Context) error {
	var found []string
	_, mcpErr := a.run("claude", "mcp", "get", "gitmind")
	if mcpErr == nil {
		found = append(found, "the gitmind MCP server")
	}
	settings := a.claudeSettings()
	root, hooks, data, err := readHooks(settings)
	if err != nil {
		return err
	}
	if hooks != nil && (hasHook(hooks["SessionStart"], "gitmind", "context") || hasHook(hooks["Stop"], "gitmind", "nudge")) {
		found = append(found, "hooks in "+tildePath(a.home, settings))
	}
	claudeMD := a.claudeMD()
	md, err := os.ReadFile(claudeMD)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	stripped, inMD := withoutAgentMemory(string(md))
	if inMD {
		found = append(found, "memory instructions in "+tildePath(a.home, claudeMD))
	}
	if len(found) == 0 {
		return nil
	}
	ok, err := a.ask(ctx, fmt.Sprintf("Remove what an earlier gitmind setup added to Claude Code (%s)? The plugin replaces it, and keeping both loads your notes twice.", joinList(found)))
	if err != nil || !ok {
		return err
	}
	if mcpErr == nil {
		if _, err := a.run("claude", "mcp", "remove", "--scope", "user", "gitmind"); err != nil {
			fmt.Fprintf(a.out, "✗ couldn't remove the gitmind MCP server: %v\n", err)
		} else {
			fmt.Fprintln(a.out, "✓ Removed the gitmind MCP server")
		}
	}
	if hooks != nil {
		removed := false
		for event, sub := range map[string]string{"SessionStart": "context", "Stop": "nudge"} {
			groups, n := withoutHook(hooks[event], "gitmind", sub)
			removed = removed || n > 0
			if len(groups) == 0 {
				delete(hooks, event)
			} else {
				hooks[event] = groups
			}
		}
		if removed {
			if len(hooks) == 0 {
				delete(root, "hooks")
			} else if raw, err := json.Marshal(hooks); err == nil {
				root["hooks"] = raw
			}
			if err := writeSettings(settings, root, data); err != nil {
				return err
			}
			fmt.Fprintf(a.out, "✓ Removed gitmind's hooks from %s (backup: settings.json.bak)\n", tildePath(a.home, settings))
		}
	}
	if inMD {
		if err := os.WriteFile(claudeMD+".bak", md, 0o644); err != nil {
			return err
		}
		if strings.TrimSpace(stripped) == "" {
			err = os.Remove(claudeMD)
		} else {
			err = os.WriteFile(claudeMD, []byte(stripped), 0o644)
		}
		if err != nil {
			return err
		}
		fmt.Fprintf(a.out, "✓ Removed gitmind's memory instructions from %s (backup: CLAUDE.md.bak)\n", tildePath(a.home, claudeMD))
	}
	return nil
}

// withoutAgentMemory removes the block instructions() appended: the current
// AGENT_MEMORY.md exactly, or else (an older version) from its heading to the
// next heading of the same or a higher level.
func withoutAgentMemory(md string) (string, bool) {
	block := strings.TrimRight(agentMemory, "\n")
	start := strings.Index(md, block)
	end := start + len(block)
	if start < 0 {
		marker := strings.SplitN(agentMemory, "\n", 2)[0]
		start = strings.Index(md, marker)
		if start < 0 {
			return md, false
		}
		end = len(md)
		rest := md[start+len(marker):]
		for _, h := range []string{"\n## ", "\n# "} {
			if i := strings.Index(rest, h); i >= 0 && start+len(marker)+i < end {
				end = start + len(marker) + i
			}
		}
	}
	before := strings.TrimRight(md[:start], "\n")
	after := strings.TrimLeft(md[end:], "\n")
	switch {
	case before == "":
		return after, true
	case after == "":
		return before + "\n", true
	}
	return before + "\n\n" + after, true
}

func joinList(items []string) string {
	if len(items) < 2 {
		return strings.Join(items, "")
	}
	return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
}

func (a *agentSetup) claudeMCP(ctx context.Context) error {
	if _, err := a.lookPath("claude"); err != nil {
		fmt.Fprintf(a.out, "• Claude Code's CLI isn't on PATH; add gitmind yourself with:\n    claude mcp add --scope user gitmind -- %s\n", shellQuote(a.exe))
		return nil
	}
	if _, err := a.run("claude", "mcp", "get", "gitmind"); err == nil {
		fmt.Fprintln(a.out, "✓ Claude Code already has the gitmind MCP server")
		return nil
	}
	ok, err := a.ask(ctx, "Add gitmind to Claude Code as an MCP server (all projects)?")
	if err != nil || !ok {
		return err
	}
	if _, err := a.run("claude", "mcp", "add", "--scope", "user", "gitmind", "--", a.exe); err != nil {
		fmt.Fprintf(a.out, "✗ couldn't add it: %v\n", err)
		return nil
	}
	fmt.Fprintln(a.out, "✓ Added gitmind to Claude Code")
	return nil
}

// claudeHooks adds the SessionStart (recall) and Stop (save nudge) hooks to
// ~/.claude/settings.json, keeping everything else in the file.
func (a *agentSetup) claudeHooks(ctx context.Context) error {
	path := a.claudeSettings()
	root, hooks, data, err := readHooks(path)
	if err != nil {
		return err
	}
	if hooks == nil {
		fmt.Fprintf(a.out, "• Skipping hooks: %s isn't plain JSON with the usual hooks shape. See https://gitmind.app/docs/cli/ to add them by hand.\n", path)
		return nil
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
	if err := writeSettings(path, root, data); err != nil {
		return err
	}
	backup := ""
	if len(data) > 0 {
		backup = " (backup: settings.json.bak)"
	}
	fmt.Fprintf(a.out, "✓ Added hooks to %s%s\n", path, backup)
	return nil
}

// readHooks reads Claude Code's settings.json. hooks is nil when the file
// isn't plain JSON (it may have comments) or its hooks have an unexpected
// shape, so it's best left alone; data is the file as read.
func readHooks(path string) (root map[string]json.RawMessage, hooks map[string][]map[string]any, data []byte, err error) {
	data, err = os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, nil, nil, err
	}
	root = map[string]json.RawMessage{}
	if len(strings.TrimSpace(string(data))) > 0 && json.Unmarshal(data, &root) != nil {
		return root, nil, data, nil
	}
	hooks = map[string][]map[string]any{}
	if raw, ok := root["hooks"]; ok && json.Unmarshal(raw, &hooks) != nil {
		return root, nil, data, nil
	}
	return root, hooks, data, nil
}

// writeSettings writes settings.json, backing up the previous contents.
func writeSettings(path string, root map[string]json.RawMessage, previous []byte) error {
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	if len(previous) > 0 {
		if err := os.WriteFile(path+".bak", previous, 0o644); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(out, '\n'), 0o644)
}

// withoutHook drops the hooks whose command contains every word, and the
// groups left empty; n is how many were dropped.
func withoutHook(groups []map[string]any, words ...string) (kept []map[string]any, n int) {
	for _, g := range groups {
		list, _ := g["hooks"].([]any)
		var rest []any
		for _, h := range list {
			if hasHook([]map[string]any{{"hooks": []any{h}}}, words...) {
				n++
			} else {
				rest = append(rest, h)
			}
		}
		if len(list) > 0 && len(rest) == 0 {
			continue
		}
		if len(rest) < len(list) {
			g["hooks"] = rest
		}
		kept = append(kept, g)
	}
	return kept, n
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
	path := a.codexConfig()
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

// claudeMemories offers to import what Claude Code remembered on this
// machine, which otherwise stays here.
func (a *agentSetup) claudeMemories(ctx context.Context) error {
	if a.dir == "" || !gitsync.IsRepo(a.dir) {
		return nil
	}
	mems, err := claudecode.Find(claudecode.ConfigDir(a.home), a.home)
	if err != nil || len(mems) == 0 {
		return nil
	}
	fmt.Fprintln(a.out)
	if err := importClaudeCode(ctx, a.dir, mems, a.out, func(q string) (bool, error) { return a.ask(ctx, q) }, false); err != nil {
		fmt.Fprintf(a.out, "✗ couldn't import Claude Code's memories: %v\n", err)
	}
	return nil
}

// ask asks a yes/no question, defaulting to yes.
func (a *agentSetup) ask(ctx context.Context, question string) (bool, error) {
	if a.assumeYes {
		return true, nil
	}
	return confirm(ctx, a.in, a.out, question)
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
