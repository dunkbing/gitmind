package main

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dunkbing/gitmind/internal/gitsync"
	"github.com/dunkbing/gitmind/internal/memory"
	"github.com/dunkbing/gitmind/internal/notes"
)

// switchRepo moves a notes folder to a new remote without losing notes: the
// folder is renamed to a dated backup, the new remote is cloned in its place,
// and notes the new location doesn't have are copied over. A note that
// exists in both places with different content is merged: the new one gains
// the lines and tags the old one had.
func switchRepo(ctx context.Context, dir, remote string, config []string) error {
	backup := fmt.Sprintf("%s.bak-%s", strings.TrimRight(dir, string(filepath.Separator)), time.Now().Format("20060102-150405"))
	if err := os.Rename(dir, backup); err != nil {
		return err
	}
	fmt.Println("Downloading the notes from the new location… (can take a minute)")
	if err := gitsync.Init(ctx, dir, remote, config...); err != nil {
		// Put the old folder back, so a failed switch changes nothing.
		os.RemoveAll(dir)
		if rerr := os.Rename(backup, dir); rerr != nil {
			return fmt.Errorf("%w (and restoring %s failed: %v)", err, backup, rerr)
		}
		return err
	}
	copied, merged, err := bringNotes(backup, dir)
	if err != nil {
		return err
	}
	if copied+merged > 0 {
		if _, err := (&gitsync.Repo{Dir: dir}).Commit(ctx, "gitmind: bring over notes from the previous location"); err != nil {
			return err
		}
		app, err := memory.Open(dir, log.Default())
		if err != nil {
			return err
		}
		defer app.Close()
		fmt.Println("Uploading the merged notes… (can take a minute)")
		if _, err := app.Sync(ctx); err != nil {
			return err
		}
	}
	fmt.Printf("✓ Switched; the previous folder is backed up at %s\n", backup)
	switch {
	case copied+merged == 0:
		fmt.Println("  All of its notes were already in the new location.")
	case merged == 0:
		fmt.Printf("  Copied over %d note(s) the new location didn't have.\n", copied)
	default:
		fmt.Printf("  Copied over %d note(s); %d differed from the new location's version and were merged into it.\n", copied, merged)
	}
	return nil
}

// bringNotes copies the Markdown notes in from that to doesn't already
// have, skipping hidden directories (.git, the index). A note both places
// have, with different content, is merged into the one in to: lines and tags
// it lacks are added, nothing is removed. It returns how many notes were
// copied and how many merged.
func bringNotes(from, to string) (copied, merged int, err error) {
	err = filepath.WalkDir(from, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p != from && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
			return nil
		}
		rel, err := filepath.Rel(from, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		dst := filepath.Join(to, rel)
		if existing, err := os.ReadFile(dst); err == nil {
			if sameNote(rel, existing, data) {
				return nil
			}
			union, changed := unionNotes(rel, existing, data)
			if !changed {
				return nil
			}
			data = union
			merged++
		} else {
			copied++
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dst, data, 0o644)
	})
	return copied, merged, err
}

// unionNotes adds to base the tags and non-blank body lines that extra has
// and base lacks, reporting whether anything was added. base keeps its title
// and settings. shortcut: compares whole trimmed lines, so a reworded fact
// is kept in both wordings; upgrade to fact-level matching if that annoys.
func unionNotes(path string, base, extra []byte) ([]byte, bool) {
	b, e := notes.Parse(path, base), notes.Parse(path, extra)
	have := map[string]bool{}
	for _, l := range strings.Split(b.Body, "\n") {
		have[strings.TrimSpace(l)] = true
	}
	var add []string
	for _, l := range strings.Split(e.Body, "\n") {
		if t := strings.TrimSpace(l); t != "" && !have[t] {
			have[t] = true
			add = append(add, l)
		}
	}
	tags := map[string]bool{}
	for _, t := range b.Tags {
		tags[t] = true
	}
	changed := len(add) > 0
	for _, t := range e.Tags {
		if !tags[t] {
			b.Tags = append(b.Tags, t)
			changed = true
		}
	}
	if len(add) > 0 {
		b.Body = strings.TrimRight(b.Body, "\n") + "\n" + strings.Join(add, "\n") + "\n"
	}
	return b.Format(), changed
}

// sameNote reports whether two versions of a note say the same thing:
// same title, tags and text, ignoring metadata such as when each copy was
// created.
func sameNote(path string, a, b []byte) bool {
	x, y := notes.Parse(path, a), notes.Parse(path, b)
	return x.Title == y.Title && strings.Join(x.Tags, " ") == strings.Join(y.Tags, " ") &&
		strings.TrimSpace(x.Body) == strings.TrimSpace(y.Body)
}

// displayRemote shortens a remote URL for messages, without credentials.
func displayRemote(remote string) string {
	u, err := url.Parse(remote)
	if err != nil || u.Host == "" {
		return remote
	}
	u.User = nil
	if strings.HasSuffix(u.Host, ".artifacts.cloudflare.net") {
		return "your gitmind cloud workspace"
	}
	return strings.TrimSuffix(u.Host+u.Path, ".git")
}
