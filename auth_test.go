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

	"github.com/dunkbing/memory-go/internal/github"
	"github.com/dunkbing/memory-go/internal/gitsync"
	"github.com/dunkbing/memory-go/internal/memory"
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

func TestConnectRepo(t *testing.T) {
	ctx := context.Background()
	gh, root := fakeAPI(t)
	config := credentialHelperConfig("/opt/memory go/memory-go")

	// First machine: the repo doesn't exist, so it's created and cloned.
	laptop := filepath.Join(t.TempDir(), "laptop")
	repo, created, err := connectRepo(ctx, gh, "octo", "memory-notes", true, laptop, config)
	if err != nil || !created || !repo.Private {
		t.Fatalf("connectRepo = %+v, %v, %v", repo, created, err)
	}
	// An empty value first (clearing global helpers), then memory-go.
	helpers := run(t, laptop, "git", "config", "--local", "--null", "--get-all", "credential.https://github.com.helper")
	if helpers != "\x00!'/opt/memory go/memory-go' credential\x00" {
		t.Errorf("credential helpers = %q", helpers)
	}
	if log := run(t, root, "git", "--git-dir", filepath.Join(root, "memory-notes.git"), "log", "--format=%s"); log != "memory-go: init" {
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

	// Second machine already has a local notes repo of its own (e.g. memory-go
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
	if _, created, err := connectRepo(ctx, gh, "octo", "octo/memory-notes", true, desktop, config); err != nil || created {
		t.Fatalf("connect existing: created=%v err=%v", created, err)
	}
	for _, f := range []string{"from-laptop.md", "from-desktop.md"} {
		if _, err := os.Stat(filepath.Join(desktop, f)); err != nil {
			t.Errorf("desktop is missing %s", f)
		}
	}
	if files := run(t, root, "git", "--git-dir", filepath.Join(root, "memory-notes.git"), "ls-tree", "-r", "--name-only", "main"); !strings.Contains(files, "from-desktop.md") {
		t.Errorf("desktop note wasn't pushed:\n%s", files)
	}

	// A directory syncing with some other remote is left alone.
	other := filepath.Join(t.TempDir(), "other")
	if err := gitsync.Init(ctx, other, ""); err != nil {
		t.Fatal(err)
	}
	run(t, other, "git", "remote", "add", "origin", "https://example.com/else.git")
	if _, _, err := connectRepo(ctx, gh, "octo", "memory-notes", true, other, config); err == nil || !strings.Contains(err.Error(), "already syncs") {
		t.Errorf("connecting a dir with another remote: %v", err)
	}

	// Someone else's missing repo can't be created on their behalf.
	if _, _, err := connectRepo(ctx, gh, "octo", "someone/notes", true, filepath.Join(t.TempDir(), "x"), config); err == nil {
		t.Error("created a repo under another owner")
	}
}

// TestGitUsesCredentialHelper builds the binary and checks that git, in a
// repository set up by setup, gets the saved token from it.
func TestGitUsesCredentialHelper(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "memory-go")
	run(t, ".", "go", "build", "-o", bin, ".")
	t.Setenv("MEMORY_GO_CREDENTIALS", filepath.Join(t.TempDir(), "github.json"))
	if err := github.SaveCredentials(github.Credentials{Login: "octo", Token: "gho_test"}); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "notes")
	if err := gitsync.Init(context.Background(), dir, "", credentialHelperConfig(bin)...); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "credential", "fill")
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader("protocol=https\nhost=github.com\npath=octo/memory-notes.git\n\n")
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
