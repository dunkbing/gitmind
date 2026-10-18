package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dunkbing/gitmind/internal/github"
	"github.com/dunkbing/gitmind/internal/gitsync"
	"github.com/dunkbing/gitmind/internal/memory"
)

func run(t *testing.T, dir string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %v: %v: %s", name, args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// fakeAPI is GitHub's REST API backed by local bare repositories, so clones
// and pushes really happen.
func fakeAPI(t *testing.T, existing ...string) (*github.Client, string) {
	root := t.TempDir()
	bare := func(name string) string {
		p := filepath.Join(root, name+".git")
		if _, err := os.Stat(p); err != nil {
			run(t, root, "git", "init", "-q", "--bare", "-b", "main", p)
		}
		return p
	}
	for _, name := range existing {
		bare(name)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/{owner}/{name}", func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(root, r.PathValue("name")+".git")
		if _, err := os.Stat(p); err != nil || r.PathValue("owner") != "octo" {
			http.Error(w, "{}", http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(github.Repo{FullName: "octo/" + r.PathValue("name"), Private: true, CloneURL: p})
	})
	mux.HandleFunc("POST /user/repos", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name    string `json:"name"`
			Private bool   `json:"private"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		json.NewEncoder(w).Encode(github.Repo{FullName: "octo/" + body.Name, Private: body.Private, CloneURL: bare(body.Name)})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := github.New("test", "gho_test")
	c.APIURL = srv.URL
	return c, root
}

// Answers for setup's switch question.
func no(string) (bool, error)  { return false, nil }
func yes(string) (bool, error) { return true, nil }

func TestConnectRepo(t *testing.T) {
	ctx := context.Background()
	gh, root := fakeAPI(t)
	config := credentialHelperConfig("/opt/memory go/gitmind")

	// First machine: the repo doesn't exist, so it's created and cloned.
	laptop := filepath.Join(t.TempDir(), "laptop")
	repo, created, err := connectRepo(ctx, gh, "octo", "gitmind-notes", true, laptop, config, no)
	if err != nil || !created || !repo.Private {
		t.Fatalf("connectRepo = %+v, %v, %v", repo, created, err)
	}
	// An empty value first (clearing global helpers), then gitmind.
	helpers := run(t, laptop, "git", "config", "--local", "--null", "--get-all", "credential.https://github.com.helper")
	if helpers != "\x00!'/opt/memory go/gitmind' credential\x00" {
		t.Errorf("credential helpers = %q", helpers)
	}
	if log := run(t, root, "git", "--git-dir", filepath.Join(root, "gitmind-notes.git"), "log", "--format=%s"); log != "gitmind: init" {
		t.Errorf("remote history = %q", log)
	}
	a, err := memory.Open(laptop, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.Write(ctx, "From laptop", "", "laptop note", nil, false); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	a.Close()

	// Second machine already has a local notes repo of its own (e.g. gitmind
	// served before setup ran): connecting merges the two histories.
	desktop := filepath.Join(t.TempDir(), "desktop")
	if err := gitsync.Init(ctx, desktop, ""); err != nil {
		t.Fatal(err)
	}
	d, _ := memory.Open(desktop, log.New(io.Discard, "", 0))
	if _, _, err := d.Write(ctx, "From desktop", "", "desktop note", nil, false); err != nil {
		t.Fatal(err)
	}
	d.Close()
	if _, created, err := connectRepo(ctx, gh, "octo", "octo/gitmind-notes", true, desktop, config, no); err != nil || created {
		t.Fatalf("connect existing: created=%v err=%v", created, err)
	}
	for _, f := range []string{"from-laptop.md", "from-desktop.md"} {
		if _, err := os.Stat(filepath.Join(desktop, f)); err != nil {
			t.Errorf("desktop is missing %s", f)
		}
	}
	if files := run(t, root, "git", "--git-dir", filepath.Join(root, "gitmind-notes.git"), "ls-tree", "-r", "--name-only", "main"); !strings.Contains(files, "from-desktop.md") {
		t.Errorf("desktop note wasn't pushed:\n%s", files)
	}

	// A directory syncing with some other remote is left alone.
	other := filepath.Join(t.TempDir(), "other")
	if err := gitsync.Init(ctx, other, ""); err != nil {
		t.Fatal(err)
	}
	run(t, other, "git", "remote", "add", "origin", "https://example.com/else.git")
	if _, _, err := connectRepo(ctx, gh, "octo", "gitmind-notes", true, other, config, no); err == nil || !strings.Contains(err.Error(), "already syncs") {
		t.Errorf("connecting a dir with another remote: %v", err)
	}

	// Someone else's missing repo can't be created on their behalf.
	if _, _, err := connectRepo(ctx, gh, "octo", "someone/notes", true, filepath.Join(t.TempDir(), "x"), config, no); err == nil {
		t.Error("created a repo under another owner")
	}
}

// TestGitUsesCredentialHelper builds the binary and checks that git, in a
// repository set up by setup, gets the saved token from it.
func TestGitUsesCredentialHelper(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "gitmind")
	run(t, ".", "go", "build", "-o", bin, ".")
	t.Setenv("GITMIND_CREDENTIALS", filepath.Join(t.TempDir(), "github.json"))
	if err := github.SaveCredentials(github.Credentials{Login: "octo", Token: "gho_test"}); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "notes")
	if err := gitsync.Init(context.Background(), dir, "", credentialHelperConfig(bin)...); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "credential", "fill")
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader("protocol=https\nhost=github.com\npath=octo/gitmind-notes.git\n\n")
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(out), "username=octo\npassword=gho_test") {
		t.Fatalf("git credential fill: %v\n%s", err, out)
	}
}

func TestSameRepoURL(t *testing.T) {
	for _, pair := range [][2]string{
		{"https://github.com/Octo/Notes.git", "https://github.com/octo/notes"},
		{"git@github.com:octo/notes.git", "https://github.com/octo/notes.git"},
	} {
		if !sameRepoURL(pair[0], pair[1]) {
			t.Errorf("%q and %q should match", pair[0], pair[1])
		}
	}
	if sameRepoURL("https://github.com/octo/notes.git", "https://github.com/octo/other.git") {
		t.Error("different repos matched")
	}
}

// A folder that already syncs elsewhere is switched only when the user
// agrees, keeping a backup and carrying its notes over.
func TestSwitchingKeepsNotes(t *testing.T) {
	ctx := context.Background()
	gh, root := fakeAPI(t, "gitmind-notes")
	remote := filepath.Join(root, "gitmind-notes.git")

	// The new location already has two notes.
	seed := filepath.Join(t.TempDir(), "seed")
	run(t, ".", "git", "clone", "-q", remote, seed)
	os.MkdirAll(filepath.Join(seed, "general"), 0o755)
	os.WriteFile(filepath.Join(seed, "general", "same.md"), []byte("---\ntitle: Same\ncreated: 2026-10-18T05:00:00Z\n---\n\nsame\n"), 0o644)
	os.WriteFile(filepath.Join(seed, "general", "prefs.md"), []byte("new version\n"), 0o644)
	run(t, seed, "git", "add", "-A")
	run(t, seed, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed")
	run(t, seed, "git", "push", "-q", "origin", "HEAD:main")

	// The local folder syncs with somewhere else and has its own notes.
	dir := filepath.Join(t.TempDir(), "notes")
	if err := gitsync.Init(ctx, dir, ""); err != nil {
		t.Fatal(err)
	}
	run(t, dir, "git", "remote", "add", "origin", "https://github.com/octo/old-notes.git")
	os.MkdirAll(filepath.Join(dir, "general"), 0o755)
	os.MkdirAll(filepath.Join(dir, "myapp"), 0o755)
	// Saved separately, so only its created time differs: still the same note.
	os.WriteFile(filepath.Join(dir, "general", "same.md"), []byte("---\ntitle: Same\ncreated: 2026-10-17T09:00:00Z\n---\n\nsame\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "general", "prefs.md"), []byte("old version\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "myapp", "deploy.md"), []byte("only here\n"), 0o644)
	run(t, dir, "git", "add", "-A")
	run(t, dir, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "old")

	// Saying no changes nothing.
	if _, _, err := connectRepo(ctx, gh, "octo", "gitmind-notes", true, dir, nil, no); err == nil || !strings.Contains(err.Error(), "github.com/octo/old-notes") {
		t.Fatalf("declined switch: %v", err)
	}
	if got := run(t, dir, "git", "remote", "get-url", "origin"); got != "https://github.com/octo/old-notes.git" {
		t.Fatalf("remote changed after declining: %s", got)
	}

	if _, _, err := connectRepo(ctx, gh, "octo", "gitmind-notes", true, dir, nil, yes); err != nil {
		t.Fatal(err)
	}
	if got := run(t, dir, "git", "remote", "get-url", "origin"); got != remote {
		t.Errorf("origin = %s, want %s", got, remote)
	}
	backups, _ := filepath.Glob(dir + ".bak-*")
	if len(backups) != 1 {
		t.Fatalf("backups = %v", backups)
	}
	if data, _ := os.ReadFile(filepath.Join(backups[0], "general", "prefs.md")); string(data) != "old version\n" {
		t.Error("the backup lost the old notes")
	}
	files := map[string]string{
		"myapp/deploy.md":           "only here\n",                                                    // only in the old folder: copied
		"general/same.md":           "---\ntitle: Same\ncreated: 2026-10-18T05:00:00Z\n---\n\nsame\n", // same note (only created differs): left alone
		"general/prefs.md":          "new version\n",                                                  // differs: new location wins...
		"general/prefs-previous.md": "old version\n",                                                  // ...and the old version is kept beside it
	}
	for path, want := range files {
		if data, err := os.ReadFile(filepath.Join(dir, path)); err != nil || string(data) != want {
			t.Errorf("%s = %q, %v; want %q", path, data, err, want)
		}
	}
	// And it was all pushed to the new location.
	pushed := run(t, root, "git", "--git-dir", remote, "ls-tree", "-r", "--name-only", "main")
	if _, err := os.Stat(filepath.Join(dir, "general", "same-previous.md")); err == nil {
		t.Error("a note differing only in its created time was kept as a duplicate")
	}
	for _, path := range []string{"myapp/deploy.md", "general/prefs-previous.md"} {
		if !strings.Contains(pushed, path) {
			t.Errorf("%s wasn't pushed:\n%s", path, pushed)
		}
	}
}
