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
// exists in both places with different content is kept next to the new one
// as NAME-previous.md.
func switchRepo(ctx context.Context, dir, remote string, config []string) error {
	backup := fmt.Sprintf("%s.bak-%s", strings.TrimRight(dir, string(filepath.Separator)), time.Now().Format("20060102-150405"))
	if err := os.Rename(dir, backup); err != nil {
		return err
	}
	if err := gitsync.Init(ctx, dir, remote, config...); err != nil {
		// Put the old folder back, so a failed switch changes nothing.
		os.RemoveAll(dir)
		if rerr := os.Rename(backup, dir); rerr != nil {
			return fmt.Errorf("%w (and restoring %s failed: %v)", err, backup, rerr)
		}
		return err
	}
	copied, kept, err := bringNotes(backup, dir)
	if err != nil {
		return err
	}
	if copied+kept > 0 {
		if _, err := (&gitsync.Repo{Dir: dir}).Commit(ctx, "gitmind: bring over notes from the previous location"); err != nil {
			return err
		}
		app, err := memory.Open(dir, log.Default())
		if err != nil {
			return err
		}
		defer app.Close()
		if _, err := app.Sync(ctx); err != nil {
			return err
		}
	}
	fmt.Printf("✓ Switched; the previous folder is backed up at %s\n", backup)
	switch {
	case copied+kept == 0:
		fmt.Println("  All of its notes were already in the new location.")
	case kept == 0:
		fmt.Printf("  Copied over %d note(s) the new location didn't have.\n", copied)
	default:
		fmt.Printf("  Copied over %d note(s); %d differed from the new location's version and were kept as *-previous.md.\n", copied, kept)
	}
	return nil
}

// bringNotes copies the Markdown notes in from that to doesn't already
// have, skipping hidden directories (.git, the index).
func bringNotes(from, to string) (copied, kept int, err error) {
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
			dst = strings.TrimSuffix(dst, ".md") + "-previous.md"
			kept++
		} else {
			copied++
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dst, data, 0o644)
	})
	return copied, kept, err
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
