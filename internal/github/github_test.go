package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeGitHub serves the device flow and the REST endpoints memory-go uses.
func fakeGitHub(t *testing.T) *Client {
	var polls atomic.Int32
	repos := map[string]Repo{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /login/device/code", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("client_id") != "test-client" || r.Form.Get("scope") != "repo" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		json.NewEncoder(w).Encode(DeviceCode{DeviceCode: "dev", UserCode: "ABCD-1234", VerificationURI: "https://github.com/login/device", ExpiresIn: 900, Interval: 1})
	})
	mux.HandleFunc("POST /login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		switch polls.Add(1) {
		case 1:
			w.Write([]byte(`{"error":"authorization_pending"}`))
		case 2:
			w.Write([]byte(`{"error":"slow_down","interval":2}`))
		default:
			w.Write([]byte(`{"access_token":"gho_test","token_type":"bearer"}`))
		}
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gho_test" {
			http.Error(w, `{"message":"Bad credentials"}`, http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"login":"octo"}`))
	})
	mux.HandleFunc("GET /repos/{owner}/{name}", func(w http.ResponseWriter, r *http.Request) {
		repo, ok := repos[r.PathValue("owner")+"/"+r.PathValue("name")]
		if !ok {
			http.Error(w, `{"message":"Not Found"}`, http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(repo)
	})
	mux.HandleFunc("POST /user/repos", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name    string `json:"name"`
			Private bool   `json:"private"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		repo := Repo{FullName: "octo/" + body.Name, Private: body.Private, CloneURL: "https://github.com/octo/" + body.Name + ".git"}
		repos[repo.FullName] = repo
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(repo)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := New("test-client", "")
	c.WebURL, c.APIURL, c.PollUnit = srv.URL, srv.URL, time.Millisecond
	return c
}

func TestDeviceFlowAndRepos(t *testing.T) {
	ctx := context.Background()
	c := fakeGitHub(t)
	dc, err := c.StartLogin(ctx)
	if err != nil || dc.UserCode != "ABCD-1234" {
		t.Fatalf("StartLogin = %+v, %v", dc, err)
	}
	token, err := c.WaitForLogin(ctx, dc)
	if err != nil || token != "gho_test" {
		t.Fatalf("WaitForLogin = %q, %v (should survive pending and slow_down)", token, err)
	}
	if _, err := c.User(ctx); err == nil || !strings.Contains(err.Error(), "auth login") {
		t.Errorf("unauthenticated User: %v", err)
	}
	c.Token = token
	if u, err := c.User(ctx); err != nil || u.Login != "octo" {
		t.Fatalf("User = %+v, %v", u, err)
	}
	if _, err := c.Repo(ctx, "octo/memory-notes"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing repo: %v", err)
	}
	created, err := c.CreateRepo(ctx, "memory-notes", true)
	if err != nil || !created.Private {
		t.Fatalf("CreateRepo = %+v, %v", created, err)
	}
	if got, err := c.Repo(ctx, "octo/memory-notes"); err != nil || got.CloneURL != created.CloneURL {
		t.Fatalf("Repo after create = %+v, %v", got, err)
	}

	if _, err := New("", "").StartLogin(ctx); err == nil {
		t.Error("login without a client ID should fail clearly")
	}
}

func TestCredentialsAndHelper(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "github.json")
	t.Setenv("MEMORY_GO_CREDENTIALS", path)

	var out bytes.Buffer
	CredentialHelper("get", strings.NewReader("protocol=https\nhost=github.com\n\n"), &out)
	if out.Len() != 0 {
		t.Errorf("answered without a login: %q", out.String())
	}

	if err := SaveCredentials(Credentials{Login: "octo", Token: "gho_test"}); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials file mode: %v, %v", info.Mode(), err)
	}

	out.Reset()
	CredentialHelper("get", strings.NewReader("protocol=https\nhost=github.com\npath=octo/memory-notes.git\n\n"), &out)
	if out.String() != "username=octo\npassword=gho_test\n" {
		t.Errorf("get = %q", out.String())
	}
	for _, input := range []string{"protocol=https\nhost=gitlab.com\n", "protocol=http\nhost=github.com\n"} {
		out.Reset()
		CredentialHelper("get", strings.NewReader(input), &out)
		if out.Len() != 0 {
			t.Errorf("leaked the token for %q", input)
		}
	}
	out.Reset()
	CredentialHelper("store", strings.NewReader("protocol=https\nhost=github.com\npassword=x\n"), &out)
	if out.Len() != 0 {
		t.Error("store should be a no-op")
	}

	if err := DeleteCredentials(); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadCredentials(); err == nil || !strings.Contains(err.Error(), "auth login") {
		t.Errorf("after logout: %v", err)
	}
}
