// Package notes reads and writes Markdown notes with a small YAML frontmatter.
//
// The format stays compatible with Basic Memory and Obsidian: a frontmatter
// block (title, tags, created, plus any unknown keys kept verbatim) followed by
// a free-form Markdown body. Notes carry no "updated" timestamp on purpose, so
// git's union merge of concurrent appends never produces duplicate keys.
package notes

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

type Note struct {
	Path    string // slash-separated, relative to the store root, ends in .md
	Title   string
	Tags    []string
	Created time.Time
	Pinned  bool     // always shown in full at session start
	Locked  bool     // written by hand; agents must not change it
	Extra   []string // unknown frontmatter lines, preserved as-is
	Body    string
}

// Permalink is the note's path without the .md extension.
func Permalink(p string) string { return strings.TrimSuffix(p, ".md") }

func Parse(p string, data []byte) Note {
	n := Note{Path: p, Title: strings.TrimSuffix(path.Base(p), ".md")}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		n.Body = text
		return n
	}
	rest := text[len("---\n"):]
	var fm string
	if end := strings.Index(rest, "\n---\n"); end >= 0 {
		fm, n.Body = rest[:end], rest[end+len("\n---\n"):]
	} else if strings.HasSuffix(rest, "\n---") {
		fm = strings.TrimSuffix(rest, "\n---")
	} else {
		n.Body = text
		return n
	}
	n.Body = strings.TrimLeft(n.Body, "\n")

	key := ""
	for _, line := range strings.Split(fm, "\n") {
		trimmed := strings.TrimSpace(line)
		if key != "" && (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") || strings.HasPrefix(trimmed, "- ")) {
			if key == "tags" {
				n.Tags = appendTag(n.Tags, strings.TrimPrefix(trimmed, "- "))
			} else {
				n.Extra = append(n.Extra, line)
			}
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			n.Extra = append(n.Extra, line)
			key = ""
			continue
		}
		key = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		switch key {
		case "title":
			if v != "" {
				n.Title = unquote(v)
			}
		case "tags":
			n.Tags = nil
			for _, t := range strings.Split(strings.Trim(v, "[]"), ",") {
				n.Tags = appendTag(n.Tags, t)
			}
		case "created":
			if t, err := time.Parse(time.RFC3339, unquote(v)); err == nil {
				n.Created = t
			}
		case "pinned":
			n.Pinned = isTrue(v)
		case "locked":
			n.Locked = isTrue(v)
		default:
			n.Extra = append(n.Extra, line)
		}
	}
	return n
}

func (n Note) Format() []byte {
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "title: %s\n", yamlString(n.Title))
	if len(n.Tags) > 0 {
		quoted := make([]string, len(n.Tags))
		for i, t := range n.Tags {
			quoted[i] = yamlString(t)
		}
		fmt.Fprintf(&b, "tags: [%s]\n", strings.Join(quoted, ", "))
	}
	if !n.Created.IsZero() {
		fmt.Fprintf(&b, "created: %s\n", n.Created.UTC().Format(time.RFC3339))
	}
	if n.Pinned {
		b.WriteString("pinned: true\n")
	}
	if n.Locked {
		b.WriteString("locked: true\n")
	}
	for _, line := range n.Extra {
		b.WriteString(line + "\n")
	}
	b.WriteString("---\n\n")
	body := strings.TrimLeft(n.Body, "\n")
	b.WriteString(body)
	if !strings.HasSuffix(body, "\n") {
		b.WriteString("\n")
	}
	return []byte(b.String())
}

// NormalizeTags trims, strips a leading '#', lowercases and dedupes tags.
func NormalizeTags(tags []string) []string {
	var out []string
	for _, t := range tags {
		out = appendTag(out, t)
	}
	return out
}

func appendTag(tags []string, t string) []string {
	t = strings.ToLower(strings.TrimPrefix(unquote(strings.TrimSpace(t)), "#"))
	if t == "" {
		return tags
	}
	for _, existing := range tags {
		if existing == t {
			return tags
		}
	}
	return append(tags, t)
}

// letterFolds covers Latin letters that don't decompose into a base letter
// plus accents, so stripping accents alone would keep them.
var letterFolds = map[rune]string{
	'đ': "d", 'ð': "d", 'ł': "l", 'ø': "o", 'ı': "i",
	'ß': "ss", 'æ': "ae", 'œ': "oe", 'þ': "th",
}

// Slugify turns a title into a file-name-safe, lowercase, hyphenated slug.
// Accents are removed ("Tiếng Việt" → "tieng-viet") because macOS and Linux
// can encode accented file names differently, which would split one note into
// two across machines. Non-Latin scripts are kept, in NFC form.
func Slugify(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range norm.NFD.String(strings.ToLower(s)) {
		switch {
		case unicode.Is(unicode.Mn, r):
			continue
		case letterFolds[r] != "":
			b.WriteString(letterFolds[r])
			dash = false
		case unicode.IsLetter(r) || unicode.IsNumber(r):
			b.WriteRune(r)
			dash = false
		case !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		}
	}
	slug := norm.NFC.String(strings.TrimRight(b.String(), "-"))
	if r := []rune(slug); len(r) > 80 {
		slug = strings.TrimRight(string(r[:80]), "-")
	}
	if slug == "" {
		return "note"
	}
	return slug
}

// CleanDir normalizes a user-supplied directory into slugified, slash-separated
// segments. It returns "" for the root.
func CleanDir(dir string) (string, error) {
	dir = strings.Trim(strings.ReplaceAll(strings.TrimSpace(dir), "\\", "/"), "/")
	if dir == "" {
		return "", nil
	}
	var segs []string
	for _, seg := range strings.Split(dir, "/") {
		if seg == ".." {
			return "", fmt.Errorf("invalid directory %q", dir)
		}
		if seg == "" || seg == "." {
			continue
		}
		segs = append(segs, Slugify(seg))
	}
	return strings.Join(segs, "/"), nil
}

type Store struct{ Root string }

var ErrNotFound = errors.New("note not found")

// abs maps a relative note path to an absolute one, refusing anything that
// escapes the root or touches hidden directories such as .git.
func (s Store) abs(rel string) (string, error) {
	clean := path.Clean(filepath.ToSlash(rel))
	if clean == "." || path.IsAbs(clean) || !strings.HasSuffix(clean, ".md") {
		return "", fmt.Errorf("invalid note path %q", rel)
	}
	for _, seg := range strings.Split(clean, "/") {
		if seg == ".." || strings.HasPrefix(seg, ".") {
			return "", fmt.Errorf("invalid note path %q", rel)
		}
	}
	return filepath.Join(s.Root, filepath.FromSlash(clean)), nil
}

// Exists reports whether a note file exists at rel, spelled exactly so:
// on case-insensitive filesystems (macOS, Windows) "Log.md" would otherwise
// find log.md, and git, which is case-sensitive, wouldn't know that path.
func (s Store) Exists(rel string) bool {
	p, err := s.abs(rel)
	if err != nil {
		return false
	}
	info, err := os.Stat(p)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	dir := s.Root
	for _, part := range strings.Split(path.Clean(filepath.ToSlash(rel)), "/") {
		entries, err := os.ReadDir(dir)
		if err != nil || !slices.ContainsFunc(entries, func(e os.DirEntry) bool { return e.Name() == part }) {
			return false
		}
		dir = filepath.Join(dir, part)
	}
	return true
}

func (s Store) Read(rel string) (Note, time.Time, error) {
	p, err := s.abs(rel)
	if err != nil {
		return Note{}, time.Time{}, err
	}
	data, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return Note{}, time.Time{}, ErrNotFound
	} else if err != nil {
		return Note{}, time.Time{}, err
	}
	info, err := os.Stat(p)
	if err != nil {
		return Note{}, time.Time{}, err
	}
	return Parse(path.Clean(filepath.ToSlash(rel)), data), info.ModTime(), nil
}

// Write stores the note atomically and returns its new modification time.
func (s Store) Write(n Note) (time.Time, error) {
	p, err := s.abs(n.Path)
	if err != nil {
		return time.Time{}, err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return time.Time{}, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".tmp-*")
	if err != nil {
		return time.Time{}, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(n.Format()); err != nil {
		tmp.Close()
		return time.Time{}, err
	}
	if err := tmp.Close(); err != nil {
		return time.Time{}, err
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		return time.Time{}, err
	}
	info, err := os.Stat(p)
	if err != nil {
		return time.Time{}, err
	}
	return info.ModTime(), nil
}

func (s Store) Delete(rel string) error {
	p, err := s.abs(rel)
	if err != nil {
		return err
	}
	if err := os.Remove(p); errors.Is(err, fs.ErrNotExist) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	// Drop directories the delete left empty, but never the root itself.
	for dir := filepath.Dir(p); dir != filepath.Clean(s.Root); dir = filepath.Dir(dir) {
		if os.Remove(dir) != nil {
			break
		}
	}
	return nil
}

// Rename moves a note file without changing its content, refusing to
// overwrite an existing note.
func (s Store) Rename(from, to string) error {
	src, err := s.abs(from)
	if err != nil {
		return err
	}
	dst, err := s.abs(to)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		return fmt.Errorf("%s already exists", to)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	for dir := filepath.Dir(src); dir != filepath.Clean(s.Root); dir = filepath.Dir(dir) {
		if os.Remove(dir) != nil {
			break
		}
	}
	return nil
}

// Walk calls fn for every .md file, skipping hidden files and directories.
func (s Store) Walk(fn func(rel string, mod time.Time) error) error {
	return filepath.WalkDir(s.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p != s.Root && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(s.Root, p)
		if err != nil {
			return err
		}
		// macOS may hand back decomposed (NFD) names; index everything as NFC
		// so paths match across machines.
		return fn(norm.NFC.String(filepath.ToSlash(rel)), info.ModTime())
	})
}

func isTrue(v string) bool {
	switch strings.ToLower(unquote(strings.TrimSpace(v))) {
	case "true", "yes", "on":
		return true
	}
	return false
}

func yamlString(s string) string {
	if s == "" || strings.ContainsAny(s, ":#[]{},&*!|>'\"%@`") || strings.TrimSpace(s) != s {
		return strconv.Quote(s)
	}
	return s
}

func unquote(s string) string {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		if u, err := strconv.Unquote(s); err == nil {
			return u
		}
	}
	if len(s) >= 2 && s[0] == '\'' && s[len(s)-1] == '\'' {
		return strings.ReplaceAll(s[1:len(s)-1], "''", "'")
	}
	return s
}

// Link is a [[wiki link]] in a note body. Relation is the text before the
// link on a list line, Basic Memory style ("- depends on [[Auth]]"), or "".
type Link struct {
	Target   string
	Relation string
}

var linkRe = regexp.MustCompile(`\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]*)?\]\]`)

// Links returns the distinct links in body, ignoring fenced code blocks.
func Links(body string) []Link {
	var links []Link
	seen := map[Link]bool{}
	for _, line := range unfencedLines(body) {
		trimmed := strings.TrimSpace(line)
		matches := linkRe.FindAllStringSubmatchIndex(line, -1)
		for i, m := range matches {
			l := Link{Target: strings.TrimSpace(line[m[2]:m[3]])}
			if i == 0 && strings.HasPrefix(trimmed, "- ") {
				l.Relation = relation(strings.TrimSpace(line[:m[0]]))
			}
			if l.Target != "" && !seen[l] {
				seen[l] = true
				links = append(links, l)
			}
		}
	}
	return links
}

// relation extracts "depends on" from a line prefix like "- depends on".
// Observation lines ("- [decision] ...") and long prose aren't relations.
func relation(prefix string) string {
	r := strings.TrimSpace(strings.TrimPrefix(prefix, "-"))
	if r == "" || strings.ContainsAny(r, "[]()#:.,") || len(strings.Fields(r)) > 4 {
		return ""
	}
	return strings.ToLower(r)
}

// LinkTarget maps a link target to the note path it names ("" for the
// directory part when the link has none) and the slug of its file name.
func LinkTarget(target string) (notePath, slug string) {
	target = strings.TrimSuffix(norm.NFC.String(strings.TrimSpace(target)), ".md")
	dir, base := path.Split(target)
	slug = Slugify(base)
	if d, err := CleanDir(dir); err == nil && d != "" {
		return d + "/" + slug + ".md", slug
	}
	return "", slug
}

// Summary returns the first meaningful line of body, shortened.
func Summary(body string) string {
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "```") || line == "---" {
			continue
		}
		if r := []rune(line); len(r) > 160 {
			return string(r[:159]) + "…"
		}
		return line
	}
	return ""
}

// Observation is a categorized fact line, Basic Memory style:
// "- [decision] use JWT #auth".
type Observation struct {
	Category string
	Text     string
}

var (
	observationRe = regexp.MustCompile(`^\s*[-*]\s+\[([^\[\]]+)\]\s+(.+)$`)
	inlineTagRe   = regexp.MustCompile(`(?:^|[\s(])#(\pL[\pL\pN_/-]*)`)
)

// Observations returns the categorized lines in body, skipping task-list
// checkboxes ("- [ ]", "- [x]") and fenced code blocks.
func Observations(body string) []Observation {
	var obs []Observation
	for _, line := range unfencedLines(body) {
		m := observationRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		category := strings.ToLower(strings.TrimSpace(m[1]))
		if category == "" || category == "x" {
			continue
		}
		obs = append(obs, Observation{Category: category, Text: strings.TrimSpace(m[2])})
	}
	return obs
}

// CurrentObservations is Observations without those under a "History"
// heading, where facts that were replaced are kept for the record.
func CurrentObservations(body string) []Observation {
	var obs []Observation
	history := false
	historyLevel := 0
	for _, line := range unfencedLines(body) {
		if m := headingRe.FindStringSubmatch(line); m != nil {
			level := len(m[1])
			if history && level > historyLevel {
				continue // a subsection of History
			}
			history = strings.EqualFold(strings.TrimSpace(m[2]), "history")
			historyLevel = level
			continue
		}
		if history {
			continue
		}
		obs = append(obs, Observations(line)...)
	}
	return obs
}

// InlineTags returns the #tags written in body, normalized like frontmatter
// tags. Markdown headings ("# Title") and URL fragments don't count.
func InlineTags(body string) []string {
	var tags []string
	for _, line := range unfencedLines(body) {
		for _, m := range inlineTagRe.FindAllStringSubmatch(line, -1) {
			tags = appendTag(tags, strings.TrimRight(m[1], "/-"))
		}
	}
	return tags
}

func unfencedLines(body string) []string {
	var lines []string
	fenced := false
	for _, line := range strings.Split(body, "\n") {
		if isFence(line) {
			fenced = !fenced
			continue
		}
		if !fenced {
			lines = append(lines, line)
		}
	}
	return lines
}

// RewriteLinks replaces the target of every [[link]] outside code fences for
// which repl returns ok, keeping any #heading and |alias. It returns the new
// body and how many links changed.
func RewriteLinks(body string, repl func(target string) (string, bool)) (string, int) {
	lines := strings.Split(body, "\n")
	count := 0
	fenced := false
	for i, line := range lines {
		if isFence(line) {
			fenced = !fenced
			continue
		}
		if fenced {
			continue
		}
		var b strings.Builder
		last := 0
		for _, m := range linkRe.FindAllStringSubmatchIndex(line, -1) {
			if r, ok := repl(strings.TrimSpace(line[m[2]:m[3]])); ok {
				b.WriteString(line[last:m[2]])
				b.WriteString(r)
				last = m[3]
				count++
			}
		}
		if last > 0 {
			b.WriteString(line[last:])
			lines[i] = b.String()
		}
	}
	return strings.Join(lines, "\n"), count
}

var headingRe = regexp.MustCompile(`^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$`)

// ReplaceSection replaces what's under the heading named section (any level,
// ignoring case and leading #s) up to the next heading of the same or a
// higher level, so subsections are replaced too. When no heading matches, it
// appends a new "## section" at the end and reports added.
func ReplaceSection(body, section, content string) (string, bool, error) {
	want := strings.ToLower(strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(section), "#")))
	if want == "" {
		return "", false, errors.New("section heading is required")
	}
	content = strings.Trim(content, "\n")
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")

	type heading struct{ line, level int }
	var headings, matches []heading
	fenced := false
	for i, line := range lines {
		if isFence(line) {
			fenced = !fenced
			continue
		}
		if m := headingRe.FindStringSubmatch(line); m != nil && !fenced {
			h := heading{i, len(m[1])}
			headings = append(headings, h)
			if strings.ToLower(m[2]) == want {
				matches = append(matches, h)
			}
		}
	}
	switch len(matches) {
	case 0:
		added := strings.TrimRight(body, "\n") + "\n\n## " + strings.TrimSpace(section) + "\n\n" + content + "\n"
		return strings.TrimLeft(added, "\n"), true, nil
	case 1:
	default:
		return "", false, fmt.Errorf("%d headings are named %q; make them unique first", len(matches), section)
	}

	start := matches[0]
	end := len(lines)
	for _, h := range headings {
		if h.line > start.line && h.level <= start.level {
			end = h.line
			break
		}
	}
	out := append([]string{}, lines[:start.line+1]...)
	out = append(out, "")
	if content != "" {
		out = append(out, content)
	}
	if end < len(lines) {
		out = append(out, "")
		out = append(out, lines[end:]...)
	}
	return strings.Join(out, "\n") + "\n", false, nil
}

func isFence(line string) bool {
	t := strings.TrimSpace(line)
	return strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~")
}
