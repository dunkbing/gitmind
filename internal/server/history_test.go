package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// call calls a tool on a server for app through an in-memory client and
// returns its text, failing the test on a tool error unless wantErr.
func call(t *testing.T, cs *mcp.ClientSession, tool string, args map[string]any, wantErr bool) string {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", tool, err)
	}
	var b strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	if res.IsError != wantErr {
		t.Fatalf("%s: IsError = %v: %s", tool, res.IsError, b.String())
	}
	return b.String()
}

func TestFactsThatChange(t *testing.T) {
	app := testApp(t)
	ctx := context.Background()
	ct, st := mcp.NewInMemoryTransports()
	if _, err := New(app, "test").Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	call(t, cs, "write_note", map[string]any{"title": "Search", "directory": "myapp",
		"content": "- [decision] use bge-m3 embeddings for semantic search #search\n- [setup] the index lives in SQLite"}, false)
	call(t, cs, "write_note", map[string]any{"title": "Style", "directory": "general", "content": "- [preference] tabs, not spaces"}, false)

	// A new note with a fact about the same thing is flagged; an unrelated
	// one, and facts in other projects, are not.
	out := call(t, cs, "write_note", map[string]any{"title": "Embeddings", "directory": "myapp",
		"content": "- [decision] use Qwen3 embeddings, which rank notes better than bge-m3\n- [decision] cache vectors per passage"}, false)
	if !strings.Contains(out, "Possibly conflicting facts") ||
		!strings.Contains(out, "existing in myapp/search.md: [decision] use bge-m3 embeddings for semantic search #search") ||
		strings.Contains(out, "cache vectors") {
		t.Errorf("write_note:\n%s", out)
	}
	if out := call(t, cs, "write_note", map[string]any{"title": "Other", "directory": "otherapp",
		"content": "- [decision] use bge-m3 embeddings for semantic search"}, false); strings.Contains(out, "conflicting") {
		t.Errorf("flagged a fact in another project:\n%s", out)
	}
	if out := call(t, cs, "edit_note", map[string]any{"identifier": "myapp/search.md", "operation": "append",
		"content": "- [preference] Tabs, not spaces"}, false); !strings.Contains(out, "existing in general/style.md: [preference] tabs, not spaces (same wording)") {
		t.Errorf("a repeated preference wasn't flagged:\n%s", out)
	}

	// Supersede the outdated decision.
	out = call(t, cs, "edit_note", map[string]any{"identifier": "myapp/search.md", "operation": "supersede",
		"find_text": "[decision] use bge-m3 embeddings for semantic search", "content": "- [decision] use Qwen3 embeddings for semantic search #search"}, false)
	if !strings.Contains(out, "moved to History") {
		t.Errorf("supersede:\n%s", out)
	}
	n, _, err := app.Store.Read("myapp/search.md")
	if err != nil {
		t.Fatal(err)
	}
	today := time.Now().Format(time.DateOnly)
	if !strings.HasPrefix(n.Body, "- [decision] use Qwen3 embeddings for semantic search #search\n") ||
		!strings.HasSuffix(n.Body, "## History\n\n- [decision] use bge-m3 embeddings for semantic search #search (replaced "+today+")\n") {
		t.Errorf("note after supersede:\n%s", n.Body)
	}
	if out := call(t, cs, "edit_note", map[string]any{"identifier": "myapp/search.md", "operation": "supersede",
		"find_text": "use FAISS", "content": "x"}, true); !strings.Contains(out, "current facts") {
		t.Errorf("superseding a missing fact:\n%s", out)
	}

	// Search leaves the replaced fact out unless asked for history.
	if out := call(t, cs, "search_notes", map[string]any{"query": "bge-m3", "directory": "myapp"}, false); strings.Contains(out, "search.md") {
		t.Errorf("search matched History:\n%s", out)
	}
	if out := call(t, cs, "search_notes", map[string]any{"query": "bge-m3", "directory": "myapp", "include_history": true}, false); !strings.Contains(out, "myapp/search.md") || !strings.Contains(out, "[history]") {
		t.Errorf("include_history:\n%s", out)
	}
	out = call(t, cs, "search_notes", map[string]any{"category": "decision", "directory": "myapp"}, false)
	if strings.Contains(out, "bge-m3 embeddings for semantic") || !strings.Contains(out, "use Qwen3 embeddings for semantic search") {
		t.Errorf("category filter showed a replaced decision:\n%s", out)
	}
}
