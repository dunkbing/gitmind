// Package gitsync commits, pulls and pushes the notes repository by shelling
// out to git, so the user's existing credentials (SSH keys, credential
// helpers) just work.
//
// Merges use the "union" driver for .md files (set up by Init), which keeps
// both sides' lines instead of writing conflict markers. If a merge still
// conflicts, the conflicted files are committed with their markers so nothing
// is lost and the next session can tidy them up.
package gitsync

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/dunkbing/memory-go/internal/lockfile"
)

type Repo struct{ Dir string }

type Result struct {
	Remote    bool     // an "origin" remote is configured
	Committed bool     // stray local edits were committed
	Pulled    bool     // new commits came in from origin
	Pushed    bool     // local commits were pushed to origin
	Conflicts []string // files committed with conflict markers
}

func (res Result) String() string {
	if !res.Remote {
		if res.Committed {
			return "Committed local edits. No remote configured, so nothing was pulled or pushed."
		}
		return "Up to date. No remote configured, so nothing was pulled or pushed."
	}
	var parts []string
	if res.Committed {
		parts = append(parts, "committed local edits")
	}
	if res.Pulled {
		parts = append(parts, "pulled new notes")
	}
	if res.Pushed {
		parts = append(parts, "pushed local notes")
	}
	s := "Already in sync with origin."
	if len(parts) > 0 {
		s = "Synced: " + strings.Join(parts, ", ") + "."
	}
	if len(res.Conflicts) > 0 {
		s += " These files had merge conflicts and were saved with conflict markers; please clean them up: " +
			strings.Join(res.Conflicts, ", ")
	}
	return s
}

func IsRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// Init makes dir a notes repository: it clones remote into an empty dir,
// otherwise runs git init (adding remote as origin when given), then makes
// sure the ignore and merge rules are committed.
func Init(ctx context.Context, dir, remote string) error {
	r := &Repo{Dir: dir}
	if !IsRepo(dir) {
		if remote != "" && isEmptyDir(dir) {
			cmd := exec.CommandContext(ctx, "git", "clone", "-q", remote, dir)
			cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
			if out, err := cmd.CombinedOutput(); err != nil {
				return fmt.Errorf("git clone: %v: %s", err, strings.TrimSpace(string(out)))
			}
		} else {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return err
			}
			if _, err := r.run(ctx, "init", "-q", "-b", "main"); err != nil {
				return err
			}
		}
	}
	if remote != "" && !r.hasRemote(ctx) {
		if _, err := r.run(ctx, "remote", "add", "origin", remote); err != nil {
			return err
		}
	}
	if err := ensureLine(filepath.Join(dir, ".gitignore"), ".memory-go/"); err != nil {
		return err
	}
	if err := ensureLine(filepath.Join(dir, ".gitattributes"), "*.md merge=union"); err != nil {
		return err
	}
	if _, err := r.Commit(ctx, "memory-go: init", ".gitignore", ".gitattributes"); err != nil {
		return err
	}
	if remote != "" {
		_, err := r.Sync(ctx, "memory-go: init")
		return err
	}
	return nil
}

// Commit stages paths (everything when none are given) and commits them,
// reporting whether there was anything to commit.
func (r *Repo) Commit(ctx context.Context, msg string, paths ...string) (bool, error) {
	unlock, err := r.lock()
	if err != nil {
		return false, err
	}
	defer unlock()
	return r.commit(ctx, msg, paths...)
}

// Push sends local commits to origin, merging first if origin moved on.
func (r *Repo) Push(ctx context.Context) error {
	unlock, err := r.lock()
	if err != nil {
		return err
	}
	defer unlock()
	if !r.hasRemote(ctx) {
		return nil
	}
	_, err = r.push(ctx)
	return err
}

// Sync commits stray local edits, pulls from origin, then pushes.
func (r *Repo) Sync(ctx context.Context, msg string) (Result, error) {
	var res Result
	unlock, err := r.lock()
	if err != nil {
		return res, err
	}
	defer unlock()
	if res.Committed, err = r.commit(ctx, msg); err != nil {
		return res, err
	}
	if res.Remote = r.hasRemote(ctx); !res.Remote {
		return res, nil
	}
	if res.Pulled, res.Conflicts, err = r.pull(ctx); err != nil {
		return res, err
	}
	res.Pushed, err = r.push(ctx)
	return res, err
}

func (r *Repo) commit(ctx context.Context, msg string, paths ...string) (bool, error) {
	if len(paths) == 0 {
		paths = []string{"."}
	}
	// A merge left unfinished (e.g. a sync killed mid-pull) blocks every later
	// pull, so conclude it, keeping whatever is in the working tree.
	merging := r.merging(ctx)
	if merging {
		paths = []string{"."}
	}
	if _, err := r.run(ctx, append([]string{"add", "-A", "--"}, paths...)...); err != nil {
		return false, err
	}
	args := append(r.identity(ctx), "commit", "-q")
	if merging {
		args = append(args, "--no-edit")
	} else {
		if _, err := r.run(ctx, "diff", "--cached", "--quiet"); err == nil {
			return false, nil
		} else if !isExitCode(err, 1) {
			return false, err
		}
		args = append(args, "-m", msg)
	}
	_, err := r.run(ctx, args...)
	return err == nil, err
}

func (r *Repo) merging(ctx context.Context) bool {
	_, err := r.run(ctx, "rev-parse", "-q", "--verify", "MERGE_HEAD")
	return err == nil
}

func (r *Repo) pull(ctx context.Context) (bool, []string, error) {
	branch, err := r.branch(ctx)
	if err != nil {
		return false, nil, err
	}
	heads, err := r.run(ctx, "ls-remote", "--heads", "origin", branch)
	if err != nil {
		return false, nil, err
	}
	if heads == "" {
		return false, nil, nil // remote branch doesn't exist yet; the push creates it
	}
	before := r.head(ctx)
	args := append(r.identity(ctx), "pull", "-q", "--no-rebase", "--no-edit", "origin", branch)
	if _, err := r.run(ctx, args...); err != nil {
		conflicts := r.conflicts(ctx)
		if len(conflicts) == 0 {
			return false, nil, err
		}
		if _, err := r.commit(ctx, ""); err != nil {
			return false, conflicts, err
		}
		return true, conflicts, nil
	}
	return r.head(ctx) != before, nil, nil
}

func (r *Repo) push(ctx context.Context) (bool, error) {
	if r.head(ctx) == "" {
		return false, nil // no commits yet
	}
	branch, err := r.branch(ctx)
	if err != nil {
		return false, err
	}
	if !r.ahead(ctx, branch) {
		return false, nil
	}
	_, err = r.run(ctx, "push", "-q", "-u", "origin", branch)
	if err != nil && strings.Contains(err.Error(), "rejected") {
		if _, _, perr := r.pull(ctx); perr != nil {
			return false, perr
		}
		_, err = r.run(ctx, "push", "-q", "-u", "origin", branch)
	}
	return err == nil, err
}

// ahead reports whether there are local commits origin doesn't have yet.
func (r *Repo) ahead(ctx context.Context, branch string) bool {
	if _, err := r.run(ctx, "rev-parse", "--verify", "-q", "refs/remotes/origin/"+branch); err != nil {
		return true // never pushed
	}
	out, err := r.run(ctx, "rev-list", "--count", "origin/"+branch+"..HEAD")
	return err != nil || out != "0"
}

func (r *Repo) hasRemote(ctx context.Context) bool {
	_, err := r.run(ctx, "remote", "get-url", "origin")
	return err == nil
}

func (r *Repo) branch(ctx context.Context) (string, error) {
	return r.run(ctx, "symbolic-ref", "--short", "HEAD")
}

func (r *Repo) head(ctx context.Context) string {
	out, err := r.run(ctx, "rev-parse", "-q", "--verify", "HEAD")
	if err != nil {
		return ""
	}
	return out
}

func (r *Repo) conflicts(ctx context.Context) []string {
	out, err := r.run(ctx, "diff", "--name-only", "--diff-filter=U")
	if err != nil || out == "" {
		return nil
	}
	return strings.Split(out, "\n")
}

// identity supplies a fallback author when the machine has no git identity,
// so commits never fail on a fresh install.
func (r *Repo) identity(ctx context.Context) []string {
	if _, err := r.run(ctx, "config", "user.email"); err == nil {
		return nil
	}
	return []string{"-c", "user.name=memory-go", "-c", "user.email=memory-go@localhost"}
}

func (r *Repo) run(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = r.Dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_MERGE_AUTOEDIT=no")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", &gitError{args: args, out: strings.TrimSpace(string(out)), err: err}
	}
	return strings.TrimSpace(string(out)), nil
}

// lock serializes git operations across every memory-go process sharing the
// repository (e.g. several agent sessions on one machine).
func (r *Repo) lock() (func(), error) {
	return lockfile.Lock(filepath.Join(r.Dir, ".memory-go", "git.lock"))
}

type gitError struct {
	args []string
	out  string
	err  error
}

func (e *gitError) Error() string {
	if e.out == "" {
		return fmt.Sprintf("git %s: %v", e.args[0], e.err)
	}
	return fmt.Sprintf("git %s: %v: %s", e.args[0], e.err, e.out)
}

func (e *gitError) Unwrap() error { return e.err }

func isExitCode(err error, code int) bool {
	var exit *exec.ExitError
	return errors.As(err, &exit) && exit.ExitCode() == code
}

func isEmptyDir(dir string) bool {
	entries, err := os.ReadDir(dir)
	return errors.Is(err, os.ErrNotExist) || (err == nil && len(entries) == 0)
}

func ensureLine(file, line string) error {
	data, err := os.ReadFile(file)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, l := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(l) == line {
			return nil
		}
	}
	if len(data) > 0 && !strings.HasSuffix(string(data), "\n") {
		data = append(data, '\n')
	}
	return os.WriteFile(file, append(data, line+"\n"...), 0o644)
}
