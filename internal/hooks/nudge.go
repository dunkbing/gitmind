// Package hooks implements Claude Code hook helpers.
package hooks

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// StopInput is the part of a Claude Code Stop hook's stdin JSON we use.
type StopInput struct {
	SessionID      string `json:"session_id"`
	TranscriptPath string `json:"transcript_path"`
	StopHookActive bool   `json:"stop_hook_active"`
}

const nudgeText = `Before you finish: this session did substantial work. If it produced anything a future session ` +
	`would otherwise have to rediscover, save it to memory now with gitmind (search first and update an existing ` +
	`note rather than duplicating). Worth saving: decisions and their reasons, the user's preferences and corrections, ` +
	`gotchas and root causes, setup or deploy knowledge not in the repo. Not worth saving: routine steps, anything ` +
	`already in the code or git history, unconfirmed suggestions, secrets. If nothing qualifies, just stop; don't save noise.`

// Nudge decides whether to remind the agent to save to memory before it
// stops: when at least threshold tool calls happened since the last memory
// write and since the last nudge. It returns the reminder, or "" to let the
// agent stop. stateDir remembers nudges per session, so each stretch of work
// is nudged once.
func Nudge(in StopInput, stateDir string, threshold int) (string, error) {
	if in.StopHookActive || in.TranscriptPath == "" || in.SessionID == "" {
		return "", nil
	}
	total, lastWrite, err := countToolCalls(in.TranscriptPath)
	if err != nil {
		return "", err
	}
	stateFile := filepath.Join(stateDir, "nudge-"+safeName(in.SessionID))
	lastNudge := 0
	if data, err := os.ReadFile(stateFile); err == nil {
		fmt.Sscan(string(data), &lastNudge)
	}
	if total-max(lastWrite, lastNudge) < threshold {
		return "", nil
	}
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(stateFile, []byte(fmt.Sprint(total)), 0o644); err != nil {
		return "", err
	}
	cleanOldState(stateDir)
	return nudgeText, nil
}

// countToolCalls counts the main conversation's tool calls in a transcript,
// and how many there were up to and including the last memory write.
func countToolCalls(transcript string) (total, lastWrite int, err error) {
	f, err := os.Open(transcript)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for sc.Scan() {
		var entry struct {
			Type        string `json:"type"`
			IsSidechain bool   `json:"isSidechain"`
			Message     struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &entry) != nil || entry.Type != "assistant" || entry.IsSidechain {
			continue
		}
		var blocks []struct {
			Type string `json:"type"`
			Name string `json:"name"`
		}
		if json.Unmarshal(entry.Message.Content, &blocks) != nil {
			continue // plain-text content
		}
		for _, b := range blocks {
			if b.Type != "tool_use" {
				continue
			}
			total++
			if isMemoryWrite(b.Name) {
				lastWrite = total
			}
		}
	}
	return total, lastWrite, sc.Err()
}

// isMemoryWrite matches write tools of any memory MCP server, e.g.
// mcp__gitmind__write_note.
func isMemoryWrite(tool string) bool {
	if !strings.HasPrefix(tool, "mcp__") {
		return false
	}
	for _, suffix := range []string{"__write_note", "__edit_note", "__move_note"} {
		if strings.HasSuffix(tool, suffix) {
			return true
		}
	}
	return false
}

func safeName(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '-' || r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return '_'
	}, s)
}

func cleanOldState(dir string) {
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > 7*24*time.Hour {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
