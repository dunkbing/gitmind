package hooks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// transcript writes a Claude Code-style JSONL transcript with the given tool
// calls, in order.
func transcript(t *testing.T, path string, tools ...string) {
	t.Helper()
	var lines []string
	add := func(v any) {
		data, _ := json.Marshal(v)
		lines = append(lines, string(data))
	}
	add(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": "do the thing"}})
	for _, tool := range tools {
		add(map[string]any{"type": "assistant", "message": map[string]any{"content": []any{
			map[string]any{"type": "text", "text": "working"},
			map[string]any{"type": "tool_use", "name": tool, "input": map[string]any{}},
		}}})
	}
	// Subagent work doesn't count.
	add(map[string]any{"type": "assistant", "isSidechain": true, "message": map[string]any{"content": []any{
		map[string]any{"type": "tool_use", "name": "Bash"},
	}}})
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func repeat(tool string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = tool
	}
	return out
}

func TestNudge(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	tr := filepath.Join(dir, "t.jsonl")
	in := StopInput{SessionID: "s1", TranscriptPath: tr}

	transcript(t, tr, repeat("Bash", 3)...)
	if got, _ := Nudge(in, state, 5); got != "" {
		t.Error("nudged after a short session")
	}

	transcript(t, tr, repeat("Bash", 6)...)
	if got, _ := Nudge(in, state, 5); got == "" {
		t.Fatal("no nudge after substantial work")
	}
	if got, _ := Nudge(in, state, 5); got != "" {
		t.Error("nudged twice for the same work")
	}
	if got, _ := Nudge(StopInput{SessionID: "s2", TranscriptPath: tr, StopHookActive: true}, state, 5); got != "" {
		t.Error("nudged while already continuing from a stop hook")
	}

	// More work after the nudge earns another nudge...
	transcript(t, tr, repeat("Edit", 12)...)
	if got, _ := Nudge(in, state, 5); got == "" {
		t.Error("no nudge after more work")
	}
	// ...unless the agent saved to memory along the way.
	transcript(t, tr, append(repeat("Edit", 10), "mcp__gitmind__write_note", "Bash")...)
	if got, _ := Nudge(StopInput{SessionID: "s3", TranscriptPath: tr}, state, 5); got != "" {
		t.Error("nudged right after a memory write")
	}
}
