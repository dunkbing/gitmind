// Package server exposes the memory App as MCP tools.
package server

import (
	"context"
	"fmt"
	"strconv"
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
	Query     string   `json:"query,omitempty" jsonschema:"words to look for in titles, tags and bodies; notes containing all of them rank first. May be omitted when filtering"`
	Directory string   `json:"directory,omitempty" jsonschema:"only notes under this directory, e.g. a project name"`
	Tags      []string `json:"tags,omitempty" jsonschema:"only notes with all of these tags (frontmatter tags or inline #tags)"`
	Category  string   `json:"category,omitempty" jsonschema:"only notes with observations in this category, e.g. decision or gotcha; the matching lines are shown"`
	Since     string   `json:"since,omitempty" jsonschema:"only notes updated on or after this date (YYYY-MM-DD) or within this period (e.g. 7d, 2w, 3m, 1y)"`
	Before    string   `json:"before,omitempty" jsonschema:"only notes last updated before this date (YYYY-MM-DD)"`
	Limit     int      `json:"limit,omitempty" jsonschema:"maximum number of results (default 10)"`
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
	Operation            string `json:"operation" jsonschema:"append, prepend, find_replace or replace_section"`
	Content              string `json:"content" jsonschema:"text to add; the replacement text for find_replace; the new content under the heading for replace_section"`
	FindText             string `json:"find_text,omitempty" jsonschema:"text to replace (find_replace only)"`
	ExpectedReplacements int    `json:"expected_replacements,omitempty" jsonschema:"fail unless find_text occurs exactly this many times"`
	Section              string `json:"section,omitempty" jsonschema:"heading text whose content to replace (replace_section only); its subsections are replaced too"`
}

type moveArgs struct {
	Identifier string  `json:"identifier" jsonschema:"note path, permalink or exact title"`
	Directory  *string `json:"directory,omitempty" jsonschema:"new directory; omit to keep the current one, \"\" for the top level"`
	Title      string  `json:"title,omitempty" jsonschema:"new title, which also renames the file; omit to keep it"`
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
		Name: "search_notes",
		Description: "Search memory notes. Full-text query (notes with all words first, then some, recent notes slightly favoured) " +
			"and/or filters by directory, tags, observation category and update date. With filters only, the newest matches come first.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in searchArgs) (*mcp.CallToolResult, any, error) {
		q, err := toQuery(in, time.Now())
		if err != nil {
			return nil, nil, err
		}
		hits, err := app.Index.Search(q)
		if err != nil {
			return nil, nil, err
		}
		return text(formatHits("No notes match.", hits)), nil, nil
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
		Name: "edit_note",
		Description: "Edit a memory note in place: append, prepend, find_replace text, or replace_section to rewrite " +
			"everything under one heading (added at the end if the heading doesn't exist).",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in editArgs) (*mcp.CallToolResult, any, error) {
		res, err := app.Edit(ctx, in.Identifier, memory.EditOp{
			Operation: in.Operation, Content: in.Content, FindText: in.FindText,
			ExpectedReplacements: in.ExpectedReplacements, Section: in.Section,
		})
		if err != nil {
			return nil, nil, err
		}
		if res.AddedSection {
			return text(fmt.Sprintf("Edited %s: no section %q existed, so it was added at the end", res.Path, in.Section)), nil, nil
		}
		return text("Edited " + res.Path), nil, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name: "move_note",
		Description: "Move a note to another directory and/or give it a new title (which renames the file). " +
			"Links to it in other notes are updated so they keep working.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in moveArgs) (*mcp.CallToolResult, any, error) {
		if in.Directory == nil && strings.TrimSpace(in.Title) == "" {
			return nil, nil, fmt.Errorf("give a new directory, a new title, or both")
		}
		to, updated, err := app.Move(ctx, in.Identifier, in.Directory, in.Title)
		if err != nil {
			return nil, nil, err
		}
		msg := "Moved to " + to
		if len(updated) > 0 {
			msg += "; updated links in " + strings.Join(updated, ", ")
		}
		return text(msg), nil, nil
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

func toQuery(in searchArgs, now time.Time) (index.Query, error) {
	q := index.Query{Text: in.Query, Tags: in.Tags, Category: in.Category, Limit: limit(in.Limit, 10)}
	var err error
	if q.Dir, err = notes.CleanDir(in.Directory); err != nil {
		return q, err
	}
	if q.Since, err = parseWhen(in.Since, now); err != nil {
		return q, fmt.Errorf("since: %w", err)
	}
	if q.Before, err = parseWhen(in.Before, now); err != nil {
		return q, fmt.Errorf("before: %w", err)
	}
	if strings.TrimSpace(q.Text) == "" && q.Dir == "" && len(q.Tags) == 0 && q.Category == "" && q.Since.IsZero() && q.Before.IsZero() {
		return q, fmt.Errorf("give a query or at least one filter (directory, tags, category, since, before)")
	}
	return q, nil
}

// parseWhen accepts a date (2026-10-01), an RFC 3339 time, or a period back
// from now: 7d, 2w, 3m or 1y.
func parseWhen(s string, now time.Time) (time.Time, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, nil
	}
	if t, err := time.Parse(time.DateOnly, s); err == nil {
		return t, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	if n, err := strconv.Atoi(s[:len(s)-1]); err == nil && n >= 0 {
		switch s[len(s)-1] {
		case 'd':
			return now.AddDate(0, 0, -n), nil
		case 'w':
			return now.AddDate(0, 0, -7*n), nil
		case 'm':
			return now.AddDate(0, -n, 0), nil
		case 'y':
			return now.AddDate(-n, 0, 0), nil
		}
	}
	return time.Time{}, fmt.Errorf("%q is not a date (YYYY-MM-DD) or period (7d, 2w, 3m, 1y)", s)
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
		for _, o := range h.Observations {
			fmt.Fprintf(&b, "  - %s\n", o)
		}
		if h.Snippet != "" && len(h.Observations) == 0 {
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
