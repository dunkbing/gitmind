// Package memory ties the note store, search index and git sync together.
// Every write is committed right away; pushes are batched in the background.
package memory

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dunkbing/memory-go/internal/gitsync"
	"github.com/dunkbing/memory-go/internal/index"
	"github.com/dunkbing/memory-go/internal/lockfile"
	"github.com/dunkbing/memory-go/internal/notes"
	"github.com/dunkbing/memory-go/internal/secrets"
	"golang.org/x/text/unicode/norm"
)

// pushDelay batches a burst of writes into a single push.
var pushDelay = 5 * time.Second

type App struct {
	Store notes.Store
	Index *index.Index
	Repo  *gitsync.Repo
	Log   *log.Logger

	host string

	mu          sync.Mutex
	pushTimer   *time.Timer
	pushPending bool

	autoStop chan struct{} // closed to stop background sync
	autoDone chan struct{} // closed when background sync has stopped
}

func Open(dir string, logger *log.Logger) (*App, error) {
	if !gitsync.IsRepo(dir) {
		return nil, fmt.Errorf("%s is not a notes repository; run: memory-go init", dir)
	}
	ix, err := index.Open(filepath.Join(dir, ".memory-go", "index.db"))
	if err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	a := &App{
		Store: notes.Store{Root: dir},
		Index: ix,
		Repo:  &gitsync.Repo{Dir: dir},
		Log:   logger,
		host:  strings.Split(host, ".")[0],
	}
	if _, err := a.reindex(context.Background()); err != nil {
		ix.Close()
		return nil, fmt.Errorf("index notes: %w", err)
	}
	return a, nil
}

// reindex picks up files that changed on disk. Their "updated" time comes
// from git, because a pull resets modification times: a note pulled today
// but written last month must not look new.
func (a *App) reindex(ctx context.Context) (int, error) {
	var committed map[string]time.Time
	var dirty map[string]bool
	loaded := false
	return a.Index.Sync(a.Store, func(rel string, mod time.Time) time.Time {
		if !loaded {
			loaded = true
			var err error
			if committed, dirty, err = a.Repo.ChangeTimes(ctx); err != nil {
				a.Log.Printf("reading change times from git, using file times: %v", err)
			}
		}
		if t, ok := committed[rel]; ok && !dirty[rel] {
			return t
		}
		return mod
	})
}

// StartAutoSync syncs once in the background right away, then every
// interval (never again when interval is 0), so the server can answer
// requests while the network is slow and long sessions see other machines'
// notes.
func (a *App) StartAutoSync(interval time.Duration) {
	a.autoStop, a.autoDone = make(chan struct{}), make(chan struct{})
	go func() {
		defer close(a.autoDone)
		for {
			// Not tied to autoStop: killing git mid-merge would leave the
			// repository half-merged, so an in-flight sync always finishes.
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			res, err := a.Sync(ctx)
			cancel()
			if err != nil {
				a.Log.Printf("background sync failed, will retry: %v", err)
			} else if len(res.Conflicts) > 0 {
				a.Log.Print(res)
			}
			if interval <= 0 {
				return
			}
			select {
			case <-a.autoStop:
				return
			case <-time.After(interval):
			}
		}
	}()
}

// Close stops background sync, pushes anything still pending and closes the
// index.
func (a *App) Close() {
	if a.autoStop != nil {
		close(a.autoStop)
		<-a.autoDone
	}
	a.mu.Lock()
	if a.pushTimer != nil {
		a.pushTimer.Stop()
	}
	a.mu.Unlock()
	a.flushPush()
	a.Index.Close()
}

// Resolve finds a note by path, permalink or title.
func (a *App) Resolve(id string) (string, error) {
	id = norm.NFC.String(strings.TrimPrefix(strings.TrimSpace(id), "memory://"))
	if id == "" {
		return "", errors.New("empty note identifier")
	}
	candidates := []string{id, id + ".md"}
	if dir, base := path.Split(strings.TrimSuffix(id, ".md")); base != "" {
		if d, err := notes.CleanDir(dir); err == nil {
			candidates = append(candidates, path.Join(d, notes.Slugify(base)+".md"))
		}
	}
	for _, c := range candidates {
		if a.Store.Exists(c) {
			return path.Clean(c), nil
		}
	}
	paths, err := a.Index.FindByTitle(id)
	if err != nil {
		return "", err
	}
	switch len(paths) {
	case 0:
		return "", fmt.Errorf("note %q not found; use search_notes to find it", id)
	case 1:
		return paths[0], nil
	default:
		return "", fmt.Errorf("several notes are titled %q, use a path instead: %s", id, strings.Join(paths, ", "))
	}
}

// Write creates a note. An existing note with the same title in the same
// directory is replaced only when overwrite is set. It reports whether the
// note is new.
func (a *App) Write(ctx context.Context, title, dir, content string, tags []string, overwrite bool) (string, bool, error) {
	unlock, err := a.writeLock()
	if err != nil {
		return "", false, err
	}
	defer unlock()
	title = norm.NFC.String(strings.TrimSpace(title))
	if title == "" {
		return "", false, errors.New("title is required")
	}
	if err := checkSecrets(title, content, strings.Join(tags, " ")); err != nil {
		return "", false, err
	}
	d, err := notes.CleanDir(dir)
	if err != nil {
		return "", false, err
	}
	n := notes.Note{
		Path:    path.Join(d, notes.Slugify(title)+".md"),
		Title:   title,
		Tags:    notes.NormalizeTags(tags),
		Created: time.Now().UTC().Truncate(time.Second),
		Body:    content,
	}
	old, _, err := a.Store.Read(n.Path)
	created := errors.Is(err, notes.ErrNotFound)
	if err != nil && !created {
		return "", false, err
	}
	verb := "add"
	if !created {
		if !overwrite {
			return "", false, fmt.Errorf("note %s already exists (titled %q); add to it with edit_note, "+
				"or call write_note with overwrite=true to replace its content", n.Path, old.Title)
		}
		verb = "update"
		n.Created, n.Extra = old.Created, old.Extra
		if len(n.Tags) == 0 {
			n.Tags = old.Tags
		}
	}
	return n.Path, created, a.save(ctx, n, verb)
}

// EditOp is a change to a note's body.
type EditOp struct {
	Operation            string // append, prepend, find_replace or replace_section
	Content              string
	FindText             string // find_replace: the text to replace
	ExpectedReplacements int    // find_replace: fail unless FindText occurs this often
	Section              string // replace_section: the heading whose content is replaced
}

type EditResult struct {
	Path         string
	AddedSection bool // replace_section found no such heading and added it
}

func (a *App) Edit(ctx context.Context, id string, op EditOp) (EditResult, error) {
	unlock, err := a.writeLock()
	if err != nil {
		return EditResult{}, err
	}
	defer unlock()
	rel, err := a.Resolve(id)
	if err != nil {
		return EditResult{}, err
	}
	n, _, err := a.Store.Read(rel)
	if err != nil {
		return EditResult{}, err
	}
	if err := checkSecrets(op.Content, op.Section); err != nil {
		return EditResult{}, err
	}
	res := EditResult{Path: rel}
	switch op.Operation {
	case "append":
		n.Body = strings.TrimRight(n.Body, "\n") + separator(n.Body, op.Content) + strings.TrimLeft(op.Content, "\n")
	case "prepend":
		n.Body = strings.TrimRight(op.Content, "\n") + "\n\n" + strings.TrimLeft(n.Body, "\n")
	case "find_replace":
		if op.FindText == "" {
			return res, errors.New("find_text is required for find_replace")
		}
		count := strings.Count(n.Body, op.FindText)
		if count == 0 {
			return res, fmt.Errorf("find_text not found in %s", rel)
		}
		if op.ExpectedReplacements > 0 && count != op.ExpectedReplacements {
			return res, fmt.Errorf("find_text occurs %d times in %s, expected %d", count, rel, op.ExpectedReplacements)
		}
		n.Body = strings.ReplaceAll(n.Body, op.FindText, op.Content)
	case "replace_section":
		if n.Body, res.AddedSection, err = notes.ReplaceSection(n.Body, op.Section, op.Content); err != nil {
			return res, fmt.Errorf("%s: %w", rel, err)
		}
	default:
		return res, fmt.Errorf("unknown operation %q (use append, prepend, find_replace or replace_section)", op.Operation)
	}
	return res, a.save(ctx, n, "edit")
}

// Move gives a note a new directory (nil keeps the current one) and/or
// title ("" keeps it). The file is first renamed in a commit of its own, with
// its content untouched, so git always records a rename and the note's
// history follows it; a second commit updates the title and links. Links to
// the note keep working: links by title only need rewriting when the title
// changes, and links by path are pointed at the new path. It returns the new
// path and the other notes whose links were updated.
func (a *App) Move(ctx context.Context, id string, dir *string, title string) (string, []string, error) {
	unlock, err := a.writeLock()
	if err != nil {
		return "", nil, err
	}
	defer unlock()
	from, err := a.Resolve(id)
	if err != nil {
		return "", nil, err
	}
	n, _, err := a.Store.Read(from)
	if err != nil {
		return "", nil, err
	}

	d := path.Dir(from)
	if d == "." {
		d = ""
	}
	if dir != nil {
		if d, err = notes.CleanDir(*dir); err != nil {
			return "", nil, err
		}
	}
	oldTitle := n.Title
	if title = norm.NFC.String(strings.TrimSpace(title)); title == "" {
		title = oldTitle
	}
	if err := checkSecrets(title); err != nil {
		return "", nil, err
	}
	to := path.Join(d, notes.Slugify(title)+".md")
	if to == from && title == oldTitle {
		return "", nil, fmt.Errorf("%s already has that directory and title", from)
	}
	if to != from && a.Store.Exists(to) {
		return "", nil, fmt.Errorf("can't move to %s: a note already exists there", to)
	}
	sources, err := a.Index.Backlinks(from)
	if err != nil {
		return "", nil, err
	}

	oldFileSlug := notes.Slugify(strings.TrimSuffix(path.Base(from), ".md"))
	oldTitleSlug := notes.Slugify(oldTitle)
	titleChanged := notes.Slugify(title) != oldTitleSlug || notes.Slugify(title) != oldFileSlug
	newTarget := func(target string) (string, bool) {
		targetPath, slug := notes.LinkTarget(target)
		if targetPath != "" {
			return notes.Permalink(to), targetPath == from && target != notes.Permalink(to)
		}
		return title, titleChanged && (slug == oldFileSlug || slug == oldTitleSlug) && target != title
	}

	if to != from {
		if err := a.Store.Rename(from, to); err != nil {
			return "", nil, err
		}
		if err := a.Index.Remove(from); err != nil {
			return "", nil, err
		}
		if _, err := a.Repo.Commit(ctx, a.message("move", from+" -> "+to), from, to); err != nil {
			return "", nil, fmt.Errorf("moved %s to %s but git commit failed: %w", from, to, err)
		}
	}

	n.Path, n.Title = to, title
	n.Body, _ = notes.RewriteLinks(n.Body, newTarget) // self-links
	for i, line := range n.Extra {
		if strings.HasPrefix(line, "permalink:") {
			n.Extra[i] = "permalink: " + notes.Permalink(to)
		}
	}
	mod, err := a.Store.Write(n)
	if err != nil {
		return "", nil, err
	}
	now := time.Now()
	if err := a.Index.Upsert(n, mod, now); err != nil {
		return "", nil, err
	}

	var updated []string
	for _, src := range sources {
		s, _, err := a.Store.Read(src.Path)
		if err != nil {
			return "", nil, err
		}
		body, changes := notes.RewriteLinks(s.Body, newTarget)
		if changes == 0 {
			continue
		}
		s.Body = body
		mod, err := a.Store.Write(s)
		if err != nil {
			return "", nil, err
		}
		if err := a.Index.Upsert(s, mod, now); err != nil {
			return "", nil, err
		}
		updated = append(updated, s.Path)
	}

	if _, err := a.Repo.Commit(ctx, a.message("relink", to), append([]string{to}, updated...)...); err != nil {
		return "", nil, fmt.Errorf("moved %s to %s but git commit of the link updates failed: %w", from, to, err)
	}
	a.schedulePush()
	return to, updated, nil
}

func (a *App) Delete(ctx context.Context, id string) (string, error) {
	unlock, err := a.writeLock()
	if err != nil {
		return "", err
	}
	defer unlock()
	rel, err := a.Resolve(id)
	if err != nil {
		return "", err
	}
	if err := a.Store.Delete(rel); err != nil {
		return "", err
	}
	if err := a.Index.Remove(rel); err != nil {
		return "", err
	}
	if _, err := a.Repo.Commit(ctx, a.message("delete", rel), rel); err != nil {
		return "", fmt.Errorf("deleted %s but git commit failed: %w", rel, err)
	}
	a.schedulePush()
	return rel, nil
}

// Sync commits edits made outside memory-go (e.g. in Obsidian), pulls,
// pushes, and reindexes whatever changed.
func (a *App) Sync(ctx context.Context) (gitsync.Result, error) {
	// A pull rewrites notes, so it must not interleave with an edit's
	// read-modify-write.
	unlock, err := a.writeLock()
	if err != nil {
		return gitsync.Result{}, err
	}
	defer unlock()
	a.mu.Lock()
	if a.pushTimer != nil {
		a.pushTimer.Stop()
	}
	a.pushPending = false
	a.mu.Unlock()

	res, err := a.Repo.Sync(ctx, a.message("sync", "local edits"))
	if _, ierr := a.reindex(ctx); ierr != nil && err == nil {
		err = ierr
	}
	return res, err
}

// writeLock serializes every read-modify-write of notes, across goroutines
// and across memory-go processes sharing the repository, so concurrent edits
// can't overwrite each other.
func (a *App) writeLock() (func(), error) {
	return lockfile.Lock(filepath.Join(a.Store.Root, ".memory-go", "write.lock"))
}

func (a *App) save(ctx context.Context, n notes.Note, verb string) error {
	mod, err := a.Store.Write(n)
	if err != nil {
		return err
	}
	if err := a.Index.Upsert(n, mod, time.Now()); err != nil {
		return err
	}
	if _, err := a.Repo.Commit(ctx, a.message(verb, n.Path), n.Path); err != nil {
		return fmt.Errorf("saved %s but git commit failed: %w", n.Path, err)
	}
	a.schedulePush()
	return nil
}

func (a *App) message(verb, what string) string {
	return fmt.Sprintf("memory: %s %s (%s)", verb, what, a.host)
}

func (a *App) schedulePush() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.pushPending = true
	if a.pushTimer != nil {
		a.pushTimer.Stop()
	}
	a.pushTimer = time.AfterFunc(pushDelay, a.flushPush)
}

func (a *App) flushPush() {
	a.mu.Lock()
	pending := a.pushPending
	a.pushPending = false
	a.mu.Unlock()
	if !pending {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := a.Repo.Push(ctx); err != nil {
		a.Log.Printf("push failed, will retry on next sync: %v", err)
	}
}

// separator keeps an appended list item in the same Markdown list, and puts
// a blank line before anything else.
func separator(body, addition string) string {
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	next := strings.TrimSpace(addition)
	if isListItem(last) && isListItem(next) {
		return "\n"
	}
	return "\n\n"
}

func isListItem(line string) bool {
	return strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* ")
}

func checkSecrets(texts ...string) error {
	if kind := secrets.Find(texts...); kind != "" {
		return fmt.Errorf("refusing to save: content looks like it contains a %s; remove it and describe where the secret lives instead", kind)
	}
	return nil
}
