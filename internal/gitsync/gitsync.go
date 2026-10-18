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
	"strconv"
	"strings"
	"time"

	"github.com/dunkbing/gitmind/internal/lockfile"
	"golang.org/x/text/unicode/norm"
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
// sure the ignore and merge rules are committed. config holds "key=value"
// git settings, used for the clone and stored in the repository's own config
// (e.g. a credential helper).
func Init(ctx context.Context, dir, remote string, config ...string) error {
	r := &Repo{Dir: dir}
	if !IsRepo(dir) {
		if remote != "" && isEmptyDir(dir) {
			var args []string
			for _, kv := range config {
				args = append(args, "-c", kv)
			}
			cmd := exec.CommandContext(ctx, "git", append(args, "clone", "-q", remote, dir)...)
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
	if err := Configure(ctx, dir, config...); err != nil {
		return err
	}
	if remote != "" && !r.hasRemote(ctx) {
		if _, err := r.run(ctx, "remote", "add", "origin", remote); err != nil {
			return err
		}
	}
	if err := ensureLine(filepath.Join(dir, ".gitignore"), ".gitmind/"); err != nil {
		return err
	}
	if err := ensureLine(filepath.Join(dir, ".gitattributes"), "*.md merge=union"); err != nil {
		return err
	}
	if _, err := r.Commit(ctx, "gitmind: init", ".gitignore", ".gitattributes"); err != nil {
		return err
	}
	if remote != "" {
		_, err := r.Sync(ctx, "gitmind: init")
		return err
	}
	return nil
}

// EnsureIgnored makes sure the repository ignores gitmind's local directory
// (search index, locks), committing .gitignore when it had to change.
func EnsureIgnored(ctx context.Context, dir string) error {
	p := filepath.Join(dir, ".gitignore")
	before, _ := os.ReadFile(p)
	if err := ensureLine(p, ".gitmind/"); err != nil {
		return err
	}
	if after, _ := os.ReadFile(p); string(after) == string(before) {
		return nil
	}
	_, err := (&Repo{Dir: dir}).Commit(ctx, "gitmind: ignore the local index", ".gitignore")
	return err
}

// Configure stores "key=value" settings in the repository's own git config,
// replacing earlier values of the same keys. Repeating a key gives it several
// values, in order.
func Configure(ctx context.Context, dir string, config ...string) error {
	r := &Repo{Dir: dir}
	reset := map[string]bool{}
	for _, kv := range config {
		key, value, ok := strings.Cut(kv, "=")
		if !ok {
			return fmt.Errorf("invalid git config %q", kv)
		}
		if !reset[key] {
			reset[key] = true
			if _, err := r.run(ctx, "config", "--local", "--unset-all", key); err != nil && !isExitCode(err, 5) {
				return err
			}
		}
		if _, err := r.run(ctx, "config", "--local", "--add", key, value); err != nil {
			return err
		}
	}
	return nil
}

// Remote returns origin's URL, or "" when there is none.
func (r *Repo) Remote(ctx context.Context) string {
	out, err := r.run(ctx, "remote", "get-url", "origin")
	if err != nil {
		return ""
	}
	return out
}

// SetRemote points origin at url, adding it if needed.
func (r *Repo) SetRemote(ctx context.Context, url string) error {
	if r.hasRemote(ctx) {
		_, err := r.run(ctx, "remote", "set-url", "origin", url)
		return err
	}
	_, err := r.run(ctx, "remote", "add", "origin", url)
	return err
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
	// Unrelated histories happen when a machine started its own notes repo
	// before connecting to an existing remote; merge them rather than fail.
	args := append(r.identity(ctx), "pull", "-q", "--no-rebase", "--no-edit", "--allow-unrelated-histories", "origin", branch)
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

// ChangeTimes reports when each file last changed: the author time of the
// newest commit touching it, by slash-separated path. Files with uncommitted
// changes are listed in dirty instead, since only their modification time is
// meaningful.
func (r *Repo) ChangeTimes(ctx context.Context) (committed map[string]time.Time, dirty map[string]bool, err error) {
	committed, dirty = map[string]time.Time{}, map[string]bool{}
	if r.head(ctx) != "" {
		// Merge commits list no files, so each file gets the time of the
		// last edit made to it on any machine.
		out, err := r.run(ctx, "-c", "core.quotepath=off", "log", "--format=%x00%at", "--name-only", "--no-renames")
		if err != nil {
			return nil, nil, err
		}
		var at time.Time
		for _, line := range strings.Split(out, "\n") {
			if ts, ok := strings.CutPrefix(line, "\x00"); ok {
				secs, err := strconv.ParseInt(ts, 10, 64)
				if err != nil {
					return nil, nil, fmt.Errorf("parse git log: %w", err)
				}
				at = time.Unix(secs, 0)
			} else if line = norm.NFC.String(strings.TrimSpace(line)); line != "" {
				if _, seen := committed[line]; !seen {
					committed[line] = at // log is newest first
				}
			}
		}
	}
	// -z keeps paths unquoted; the output is untrimmed because each entry
	// starts with a status column that may be a space.
	out, err := r.runRaw(ctx, "status", "--porcelain", "-z", "--no-renames", "--untracked-files=all")
	if err != nil {
		return nil, nil, err
	}
	for _, entry := range strings.Split(out, "\x00") {
		if len(entry) > 3 {
			dirty[norm.NFC.String(entry[3:])] = true
		}
	}
	return committed, dirty, nil
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
	return []string{"-c", "user.name=gitmind", "-c", "user.email=gitmind@localhost"}
}

func (r *Repo) run(ctx context.Context, args ...string) (string, error) {
	out, err := r.runRaw(ctx, args...)
	return strings.TrimSpace(out), err
}

// runRaw is run without trimming the output.
func (r *Repo) runRaw(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = r.Dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_MERGE_AUTOEDIT=no")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", &gitError{args: args, out: strings.TrimSpace(string(out)), err: err}
	}
	return string(out), nil
}

// lock serializes git operations across every gitmind process sharing the
// repository (e.g. several agent sessions on one machine).
func (r *Repo) lock() (func(), error) {
	return lockfile.Lock(filepath.Join(r.Dir, ".gitmind", "git.lock"))
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
