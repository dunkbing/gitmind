// Package server exposes the memory App as MCP tools.
package server

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/dunkbing/memory-go/internal/index"
	"github.com/dunkbing/memory-go/internal/memory"
	"github.com/dunkbing/memory-go/internal/notes"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const instructions = `Persistent memory shared across the user's machines and agents, stored as Markdown notes in a git repository.
Search it before starting work on a topic; save decisions, preferences, gotchas and setup knowledge when you finish.
Prefer editing an existing note over creating a near-duplicate. Never store secrets.`

type searchArgs struct {
	Query     string `json:"query" jsonschema:"words to look for in note titles, tags and bodies"`
	Directory string `json:"directory,omitempty" jsonschema:"only search under this directory, e.g. a project name"`
	Limit     int    `json:"limit,omitempty" jsonschema:"maximum number of results (default 10)"`
}

type readArgs struct {
	Identifier string `json:"identifier" jsonschema:"note path (e.g. myapp/deploy.md), permalink (myapp/deploy) or exact title"`
}

type writeArgs struct {
	Title     string   `json:"title" jsonschema:"note title; also determines the file name"`
	Directory string   `json:"directory,omitempty" jsonschema:"folder for the note, e.g. the project name or 'general'"`
	Content   string   `json:"content" jsonschema:"Markdown body. Write facts as '- [category] fact #tag' and link notes with [[Title]]"`
	Tags      []string `json:"tags,omitempty" jsonschema:"tags for the note; kept from the existing note when omitted"`
	Overwrite bool     `json:"overwrite,omitempty" jsonschema:"replace the content of an existing note with the same title and directory (default false)"`
}

type editArgs struct {
	Identifier           string `json:"identifier" jsonschema:"note path, permalink or exact title"`
	Operation            string `json:"operation" jsonschema:"append, prepend or find_replace"`
	Content              string `json:"content" jsonschema:"text to add, or the replacement text for find_replace"`
	FindText             string `json:"find_text,omitempty" jsonschema:"text to replace (find_replace only)"`
	ExpectedReplacements int    `json:"expected_replacements,omitempty" jsonschema:"fail unless find_text occurs exactly this many times"`
}

type contextArgs struct {
	Identifier string `json:"identifier" jsonschema:"note path, permalink or exact title"`
	Depth      int    `json:"depth,omitempty" jsonschema:"1 for direct links (default), 2 to also list notes two links away"`
}

type projectArgs struct {
	Project string `json:"project,omitempty" jsonschema:"project name: the git repository's directory name; omit for general notes only"`
}

type recentArgs struct {
	Limit int `json:"limit,omitempty" jsonschema:"maximum number of notes (default 10)"`
}

type listArgs struct {
	Directory string `json:"directory,omitempty" jsonschema:"only list notes under this directory"`
}

type noArgs struct{}

func New(app *memory.App, version string) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "memory-go", Version: version}, &mcp.ServerOptions{Instructions: instructions})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "search_notes",
		Description: "Full-text search over memory notes, best matches first. Any of the words may match.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in searchArgs) (*mcp.CallToolResult, any, error) {
		dir, err := notes.CleanDir(in.Directory)
		if err != nil {
			return nil, nil, err
		}
		hits, err := app.Index.Search(in.Query, dir, limit(in.Limit, 10))
		if err != nil {
			return nil, nil, err
		}
		return text(formatHits(fmt.Sprintf("No notes match %q.", in.Query), hits)), nil, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "read_note",
		Description: "Read a memory note in full.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in readArgs) (*mcp.CallToolResult, any, error) {
		rel, err := app.Resolve(in.Identifier)
		if err != nil {
			return nil, nil, err
		}
		n, mod, err := app.Store.Read(rel)
		if err != nil {
			return nil, nil, err
		}
		out := fmt.Sprintf("path: %s\nmodified: %s\n\n%s", rel, mod.Format(time.RFC3339), n.Format())
		back, err := app.Index.Backlinks(rel)
		if err != nil {
			return nil, nil, err
		}
		if len(back) > 0 {
			titles := make([]string, len(back))
			for i, h := range back {
				titles[i] = "[[" + h.Title + "]]"
			}
			out += "\nLinked from: " + strings.Join(titles, ", ") + "\n"
		}
		return text(out), nil, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name: "build_context",
		Description: "Read a note together with its neighbourhood: the notes it links to, the notes linking to it " +
			"(with a one-line summary of each), and links to notes not written yet. Use it to follow a topic across notes.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in contextArgs) (*mcp.CallToolResult, any, error) {
		out, err := app.BuildContext(in.Identifier, in.Depth)
		if err != nil {
			return nil, nil, err
		}
		return text(out), nil, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name: "project_context",
		Description: "Load what memory knows about a project: its notes, general cross-project notes and recent activity. " +
			"Call it at the start of a session, unless that context was already provided.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in projectArgs) (*mcp.CallToolResult, any, error) {
		dir, err := notes.CleanDir(in.Project)
		if err != nil {
			return nil, nil, err
		}
		out, err := app.SessionContext(dir, 12000)
		if err != nil {
			return nil, nil, err
		}
		return text(out), nil, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name: "write_note",
		Description: "Create a memory note. Fails if a note with the same title already exists in that directory, " +
			"unless overwrite is true; to add to an existing note, use edit_note instead.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in writeArgs) (*mcp.CallToolResult, any, error) {
		rel, created, err := app.Write(ctx, in.Title, in.Directory, in.Content, in.Tags, in.Overwrite)
		if err != nil {
			return nil, nil, err
		}
		verb := "Updated"
		if created {
			verb = "Created"
		}
		return text(fmt.Sprintf("%s %s", verb, rel)), nil, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "edit_note",
		Description: "Edit a memory note in place: append, prepend, or find_replace text in its body.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in editArgs) (*mcp.CallToolResult, any, error) {
		rel, err := app.Edit(ctx, in.Identifier, in.Operation, in.Content, in.FindText, in.ExpectedReplacements)
		if err != nil {
			return nil, nil, err
		}
		return text("Edited " + rel), nil, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "delete_note",
		Description: "Delete a memory note. Git history keeps the old content.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in readArgs) (*mcp.CallToolResult, any, error) {
		rel, err := app.Delete(ctx, in.Identifier)
		if err != nil {
			return nil, nil, err
		}
		return text("Deleted " + rel), nil, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "recent_activity",
		Description: "List the most recently changed memory notes, newest first. Useful when resuming work.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in recentArgs) (*mcp.CallToolResult, any, error) {
		hits, err := app.Index.Recent(limit(in.Limit, 10))
		if err != nil {
			return nil, nil, err
		}
		return text(formatHits("Memory is empty.", hits)), nil, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "list_notes",
		Description: "List memory notes by path, optionally under one directory.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listArgs) (*mcp.CallToolResult, any, error) {
		dir, err := notes.CleanDir(in.Directory)
		if err != nil {
			return nil, nil, err
		}
		hits, err := app.Index.List(dir)
		if err != nil {
			return nil, nil, err
		}
		return text(formatHits("No notes found.", hits)), nil, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "sync_memory",
		Description: "Pull notes saved from other machines and push local ones. Runs automatically at startup and after writes.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ noArgs) (*mcp.CallToolResult, any, error) {
		res, err := app.Sync(ctx)
		if err != nil {
			return nil, nil, err
		}
		return text(res.String()), nil, nil
	})

	return s
}

func formatHits(empty string, hits []index.Hit) string {
	if len(hits) == 0 {
		return empty
	}
	var b strings.Builder
	for _, h := range hits {
		fmt.Fprintf(&b, "- %s (%s, modified %s)", h.Title, h.Path, h.Modified.Format("2006-01-02"))
		if len(h.Tags) > 0 {
			fmt.Fprintf(&b, " #%s", strings.Join(h.Tags, " #"))
		}
		b.WriteString("\n")
		if h.Snippet != "" {
			fmt.Fprintf(&b, "  %s\n", strings.Join(strings.Fields(h.Snippet), " "))
		}
	}
	return b.String()
}

func text(s string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}
}

func limit(n, def int) int {
	if n <= 0 {
		return def
	}
	return min(n, 100)
}
