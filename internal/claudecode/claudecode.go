// Package claudecode reads Claude Code's own memory ("auto memory"): one
// directory per project under ~/.claude/projects/<project>/memory, holding
// a MEMORY.md index and one Markdown file per memory, with frontmatter
// (name, description, and a type: user, feedback, project or reference).
// That memory stays on the machine; importing it into gitmind makes it
// follow the user to every machine and app.
package claudecode

import (
	"bufio"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/dunkbing/gitmind/internal/notes"
)

// Memory is one Claude Code memory file.
type Memory struct {
	Project     string // gitmind directory for it: the project's name, or "general"
	File        string
	Name        string // its slug, used in [[links]] between memories
	Title       string
	Description string
	Type        string // user, feedback, project or reference
	Body        string
	Modified    time.Time
}

// ConfigDir is where Claude Code keeps its data: $CLAUDE_CONFIG_DIR, or
// ~/.claude.
func ConfigDir(home string) string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	return filepath.Join(home, ".claude")
}

// Find reads every memory of every project.
func Find(configDir, home string) ([]Memory, error) {
	dirs, err := filepath.Glob(filepath.Join(configDir, "projects", "*", "memory"))
	if err != nil {
		return nil, err
	}
	var out []Memory
	for _, dir := range dirs {
		project := ProjectDir(filepath.Base(filepath.Dir(dir)), home)
		titles := indexTitles(filepath.Join(dir, "MEMORY.md"))
		files, _ := filepath.Glob(filepath.Join(dir, "*.md"))
		for _, f := range files {
			if strings.EqualFold(filepath.Base(f), "MEMORY.md") {
				continue
			}
			m, err := read(f)
			if err != nil {
				return nil, err
			}
			m.Project = project
			if m.Type == "user" {
				m.Project = "general" // who the user is applies everywhere
			}
			if t := titles[filepath.Base(f)]; t != "" {
				m.Title = t
			} else {
				m.Title = humanize(m.Name)
			}
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].File < out[j].File })
	return out, nil
}

// ProjectDir turns Claude Code's directory name for a project (its path
// with "/" replaced by "-", e.g. -home-me-code-my-app) into the gitmind
// directory for its notes: the project's folder name ("my-app"), found by
// checking which real directories the name can stand for, or "general"
// for the home directory.
func ProjectDir(slug, home string) string {
	tokens := strings.Split(strings.TrimPrefix(slug, "-"), "-")
	cur := "/"
	for i := 0; i < len(tokens); {
		// The longest run of tokens that names an existing directory wins
		// ("my-app" over "my/app").
		j := len(tokens)
		for ; j > i; j-- {
			if info, err := os.Stat(filepath.Join(cur, strings.Join(tokens[i:j], "-"))); err == nil && info.IsDir() {
				break
			}
		}
		if j == i { // the project directory is gone: keep the rest as one name
			cur = filepath.Join(cur, strings.Join(tokens[i:], "-"))
			break
		}
		cur = filepath.Join(cur, strings.Join(tokens[i:j], "-"))
		i = j
	}
	if home != "" && filepath.Clean(cur) == filepath.Clean(home) {
		return "general"
	}
	d, err := notes.CleanDir(strings.ToLower(filepath.Base(cur)))
	if err != nil || d == "" {
		return "general"
	}
	return d
}

var indexLine = regexp.MustCompile(`^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)`)

// indexTitles reads MEMORY.md's "- [Title](file.md) — hook" lines.
func indexTitles(file string) map[string]string {
	out := map[string]string{}
	f, err := os.Open(file)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if m := indexLine.FindStringSubmatch(sc.Text()); m != nil {
			out[path.Base(m[2])] = strings.TrimSpace(m[1])
		}
	}
	return out
}

func read(file string) (Memory, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return Memory{}, err
	}
	m := Memory{File: file, Name: strings.TrimSuffix(filepath.Base(file), ".md")}
	if info, err := os.Stat(file); err == nil {
		m.Modified = info.ModTime()
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if rest, ok := strings.CutPrefix(text, "---\n"); ok {
		if fm, body, ok := strings.Cut(rest, "\n---"); ok {
			for _, line := range strings.Split(fm, "\n") {
				key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
				if !ok {
					continue
				}
				value = strings.Trim(strings.TrimSpace(value), `"'`)
				switch key {
				case "name":
					m.Name = value
				case "description":
					m.Description = value
				case "type":
					m.Type = value
				case "modified":
					if t, err := time.Parse(time.RFC3339, value); err == nil {
						m.Modified = t
					}
				}
			}
			text = strings.TrimPrefix(body, "\n")
		}
	}
	m.Body = strings.TrimSpace(text)
	return m, nil
}

func humanize(name string) string {
	s := strings.TrimSpace(strings.NewReplacer("-", " ", "_", " ").Replace(name))
	if s == "" {
		return "Memory"
	}
	r := []rune(s)
	r[0] = unicode.ToUpper(r[0])
	return string(r)
}

// categories maps Claude Code's memory types to observation categories.
var categories = map[string]string{
	"user":      "preference",
	"feedback":  "instruction",
	"project":   "project",
	"reference": "artifact",
}

var wikiLink = regexp.MustCompile(`\[\[([^\]|#]+)(#[^\]|]*)?(\|[^\]]*)?\]\]`)

// Notes converts memories to gitmind notes: the description becomes the
// first line, an observation in the category matching the memory's type;
// the memory's text follows, its [[links]] pointing at the new titles.
func Notes(mems []Memory) []notes.Note {
	titleOf := map[string]string{}
	for _, m := range mems {
		titleOf[m.Name] = m.Title
	}
	out := make([]notes.Note, 0, len(mems))
	for _, m := range mems {
		body := wikiLink.ReplaceAllStringFunc(m.Body, func(s string) string {
			sm := wikiLink.FindStringSubmatch(s)
			if t, ok := titleOf[strings.TrimSpace(sm[1])]; ok {
				return "[[" + t + sm[2] + sm[3] + "]]"
			}
			return s
		})
		var b strings.Builder
		if m.Description != "" {
			cat := categories[m.Type]
			if cat == "" {
				cat = "note"
			}
			b.WriteString("- [" + cat + "] " + m.Description + "\n\n")
		}
		b.WriteString(body + "\n")
		tags := []string{"claude-code"}
		if m.Type != "" {
			tags = append(tags, m.Type)
		}
		created := m.Modified.UTC().Truncate(time.Second)
		if created.IsZero() {
			created = time.Now().UTC().Truncate(time.Second)
		}
		out = append(out, notes.Note{
			Path:    path.Join(m.Project, notes.Slugify(m.Title)+".md"),
			Title:   m.Title,
			Tags:    notes.NormalizeTags(tags),
			Created: created,
			Body:    b.String(),
		})
	}
	return out
}
