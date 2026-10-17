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

// maxNoteChars caps how much of one note SessionContext includes, so a single
// long note can't crowd out the rest.
const maxNoteChars = 1500

// SessionContext renders what a new agent session should know up front: the
// project's notes, cross-project notes in general/, and recent activity,
// within roughly budget bytes. Notes that don't fit are listed by title.
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
	b.WriteString("Persistent notes shared across the user's machines. Use the memory-go tools " +
		"(search_notes, read_note, build_context, write_note, edit_note) to look things up and to save what you learn.\n")
	if project != "" {
		fmt.Fprintf(&b, "Current project: %q. Save project-specific notes in directory %q; cross-project ones in \"general\".\n", project, project)
	}
	if len(projectNotes)+len(general)+len(recent) == 0 {
		b.WriteString("\nMemory is empty so far.\n")
		return b.String(), nil
	}

	shown := map[string]bool{}
	if project != "" {
		if len(projectNotes) == 0 {
			fmt.Fprintf(&b, "\n## Project notes (%s)\nNone yet.\n", project)
		} else {
			a.writeNotes(&b, fmt.Sprintf("Project notes (%s)", project), projectNotes, budget, shown)
		}
	}
	a.writeNotes(&b, "General notes", general, budget, shown)

	var others []index.Hit
	for _, h := range recent {
		if !shown[h.Path] && len(others) < 5 {
			others = append(others, h)
		}
	}
	if len(others) > 0 {
		b.WriteString("\n## Recently updated elsewhere\n")
		for _, h := range others {
			fmt.Fprintf(&b, "- %s (%s, %s)\n", h.Title, h.Path, h.Modified.Format("2006-01-02"))
		}
	}
	return b.String(), nil
}

// writeNotes includes whole notes while the budget allows, then lists the
// rest by title so the agent knows they exist.
func (a *App) writeNotes(b *strings.Builder, heading string, hits []index.Hit, budget int, shown map[string]bool) {
	if len(hits) == 0 {
		return
	}
	fmt.Fprintf(b, "\n## %s\n", heading)
	var rest []index.Hit
	for _, h := range hits {
		shown[h.Path] = true
		n, _, err := a.Store.Read(h.Path)
		if err != nil {
			continue
		}
		body := strings.TrimSpace(n.Body)
		if r := []rune(body); len(r) > maxNoteChars {
			body = string(r[:maxNoteChars]) + fmt.Sprintf("\n… (truncated; read_note %s for the rest)", h.Path)
		}
		entry := fmt.Sprintf("\n### %s (%s)\n%s\n", n.Title, h.Path, body)
		if len(rest) > 0 || b.Len()+len(entry) > budget {
			rest = append(rest, h)
			continue
		}
		b.WriteString(entry)
	}
	if len(rest) > 0 {
		const maxTitles = 25
		b.WriteString("\nMore notes (use read_note):\n")
		for i, h := range rest {
			if i == maxTitles {
				fmt.Fprintf(b, "- … and %d more (use list_notes or search_notes)\n", len(rest)-maxTitles)
				break
			}
			fmt.Fprintf(b, "- %s (%s)\n", h.Title, h.Path)
		}
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
