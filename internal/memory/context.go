package memory

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/dunkbing/memory-go/internal/index"
	"github.com/dunkbing/memory-go/internal/notes"
)

// BuildContext renders a note with its neighbourhood in the link graph:
// notes it links to, notes linking to it, links to notes not written yet and,
// at depth 2, the notes one step further out.
func (a *App) BuildContext(id string, depth int) (string, error) {
	rel, err := a.Resolve(id)
	if err != nil {
		return "", err
	}
	n, mod, err := a.Store.Read(rel)
	if err != nil {
		return "", err
	}
	out, missing, err := a.Index.Outgoing(rel)
	if err != nil {
		return "", err
	}
	back, err := a.Index.Backlinks(rel)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# %s\npath: %s · modified %s\n\n%s\n", n.Title, rel, mod.Format("2006-01-02"), strings.TrimSpace(n.Body))
	if len(out) > 0 {
		b.WriteString("\n## Links to\n")
		for _, h := range out {
			a.writeLinkLine(&b, h.Relation, h.Hit)
		}
	}
	if len(back) > 0 {
		b.WriteString("\n## Linked from\n")
		for _, h := range back {
			a.writeLinkLine(&b, h.Relation, h.Hit)
		}
	}
	if len(missing) > 0 {
		b.WriteString("\n## Links to notes that don't exist yet\n")
		for _, m := range missing {
			fmt.Fprintf(&b, "- [[%s]]\n", m)
		}
	}
	if depth >= 2 {
		if err := a.writeSecondDegree(&b, rel, append(out, back...)); err != nil {
			return "", err
		}
	}
	if len(out)+len(back)+len(missing) == 0 {
		b.WriteString("\nThis note has no links yet. Link related notes with [[Title]].\n")
	}
	return b.String(), nil
}

func (a *App) writeSecondDegree(b *strings.Builder, rel string, neighbours []index.LinkHit) error {
	seen := map[string]bool{rel: true}
	for _, h := range neighbours {
		seen[h.Path] = true
	}
	var lines []string
	for _, h := range neighbours {
		out, _, err := a.Index.Outgoing(h.Path)
		if err != nil {
			return err
		}
		back, err := a.Index.Backlinks(h.Path)
		if err != nil {
			return err
		}
		for _, far := range append(out, back...) {
			if seen[far.Path] {
				continue
			}
			seen[far.Path] = true
			lines = append(lines, fmt.Sprintf("- [[%s]] (%s), via [[%s]]\n", far.Title, far.Path, h.Title))
		}
	}
	if len(lines) == 0 {
		return nil
	}
	const max = 20
	b.WriteString("\n## Two links away\n")
	for i, l := range lines {
		if i == max {
			fmt.Fprintf(b, "- … and %d more\n", len(lines)-max)
			break
		}
		b.WriteString(l)
	}
	return nil
}

func (a *App) writeLinkLine(b *strings.Builder, relation string, h index.Hit) {
	b.WriteString("- ")
	if relation != "" {
		b.WriteString(relation + " ")
	}
	fmt.Fprintf(b, "[[%s]] (%s)", h.Title, h.Path)
	if s := a.summary(h.Path); s != "" {
		b.WriteString(": " + s)
	}
	b.WriteString("\n")
}

func (a *App) summary(rel string) string {
	n, _, err := a.Store.Read(rel)
	if err != nil {
		return ""
	}
	return notes.Summary(n.Body)
}

// maxNoteChars caps how much of one pinned note SessionContext includes, so a
// single long note can't crowd out the rest.
const maxNoteChars = 1500

// SessionContext renders what a new agent session should know up front,
// within roughly budget bytes: pinned notes (of the project and general/) in
// full, then an index of the project's notes, general notes and recent
// activity elsewhere, one line each, for the agent to open as needed. Keeping
// most notes as an index scales to large memories and keeps the injected text
// stable between sessions.
func (a *App) SessionContext(project string, budget int) (string, error) {
	var projectNotes []index.Hit
	if project != "" {
		var err error
		if projectNotes, err = a.Index.List(project); err != nil {
			return "", err
		}
	}
	general, err := a.Index.List("general")
	if err != nil {
		return "", err
	}
	recent, err := a.Index.Recent(20)
	if err != nil {
		return "", err
	}
	for _, hits := range [][]index.Hit{projectNotes, general} {
		sort.SliceStable(hits, func(i, j int) bool { return hits[i].Modified.After(hits[j].Modified) })
	}

	var b strings.Builder
	b.WriteString("# Memory (memory-go)\n\n")
	b.WriteString("Persistent notes shared across the user's machines. Below: pinned notes in full, then an index of " +
		"other notes; open them with read_note or build_context when relevant, and use search_notes for anything else.\n")
	if project != "" {
		fmt.Fprintf(&b, "Current project: %q. Save project-specific notes in directory %q; cross-project ones in \"general\".\n", project, project)
	}
	if len(projectNotes)+len(general)+len(recent) == 0 {
		b.WriteString("\nMemory is empty so far.\n")
		return b.String(), nil
	}

	// Pinned notes get at most 60% of the budget so the index always fits;
	// pinned notes that don't fit are listed in the index instead.
	var pinnedShown []string
	shown := map[string]bool{}
	for _, h := range append(append([]index.Hit{}, projectNotes...), general...) {
		if !h.Pinned {
			continue
		}
		n, _, err := a.Store.Read(h.Path)
		if err != nil {
			continue
		}
		body := strings.TrimSpace(n.Body)
		if r := []rune(body); len(r) > maxNoteChars {
			body = string(r[:maxNoteChars]) + fmt.Sprintf("\n… (truncated; read_note %s for the rest)", h.Path)
		}
		entry := fmt.Sprintf("\n### %s (%s)\n%s\n", n.Title, h.Path, body)
		if b.Len()+len(entry) > budget*6/10 {
			continue
		}
		if len(pinnedShown) == 0 {
			b.WriteString("\n## Pinned notes\n")
		}
		b.WriteString(entry)
		pinnedShown = append(pinnedShown, h.Path)
		shown[h.Path] = true
	}

	if project != "" {
		heading := fmt.Sprintf("\n## Project notes (%s)\n", project)
		if len(projectNotes) == 0 {
			b.WriteString(heading + "None yet.\n")
		}
		writeIndex(&b, heading, projectNotes, shown, budget, fmt.Sprintf("list_notes directory %q", project))
	}
	writeIndex(&b, "\n## General notes\n", general, shown, budget, `list_notes directory "general"`)
	var others []index.Hit
	for _, h := range recent {
		if !shown[h.Path] && !strings.HasPrefix(h.Path, project+"/") && len(others) < 5 {
			others = append(others, h)
		}
	}
	writeIndex(&b, "\n## Recently updated elsewhere\n", others, shown, budget, "recent_activity")
	return b.String(), nil
}

// writeIndex lists notes not shown yet under heading, one line each until
// the budget runs out, then says how many more there are and where to find
// them. It writes nothing when every note was already shown.
func writeIndex(b *strings.Builder, heading string, hits []index.Hit, shown map[string]bool, budget int, more string) {
	left := 0
	wroteHeading := false
	for _, h := range hits {
		if shown[h.Path] {
			continue
		}
		if !wroteHeading {
			b.WriteString(heading)
			wroteHeading = true
		}
		line := fmt.Sprintf("- %s (%s, %s)", h.Title, h.Path, h.Modified.Format("2006-01-02"))
		if h.Pinned {
			line += " [pinned]"
		}
		if h.Summary != "" {
			line += ": " + h.Summary
		}
		line += "\n"
		if left > 0 || b.Len()+len(line) > budget {
			left++
			continue
		}
		b.WriteString(line)
		shown[h.Path] = true
	}
	if left > 0 {
		fmt.Fprintf(b, "- … and %d more (%s)\n", left, more)
	}
}

// ProjectName derives the memory directory for the code project at cwd: the
// git repository's name (the main checkout's, for worktrees), else the
// directory's own name. It returns "" outside any project, e.g. in $HOME.
func ProjectName(cwd string) string {
	if cwd == "" {
		return ""
	}
	dir := cwd
	if out, err := exec.Command("git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir").Output(); err == nil {
		common := filepath.Clean(strings.TrimSpace(string(out)))
		if filepath.Base(common) == ".git" {
			dir = filepath.Dir(common)
		} else {
			dir = strings.TrimSuffix(common, ".git") // bare repository
		}
	}
	dir = filepath.Clean(dir)
	if home, err := os.UserHomeDir(); err == nil && dir == filepath.Clean(home) {
		return ""
	}
	if dir == "/" || dir == "." {
		return ""
	}
	return notes.Slugify(filepath.Base(dir))
}
