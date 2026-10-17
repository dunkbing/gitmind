package cloud

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeServer implements the cloud's OAuth and CLI API endpoints; its
// /authorize approves immediately, as a signed-in user clicking Allow would.
func fakeServer(t *testing.T) *httptest.Server {
	var challenge, redirect string
	refreshes := 0
	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth/register", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			RedirectURIs []string `json:"redirect_uris"`
			AuthMethod   string   `json:"token_endpoint_auth_method"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.AuthMethod != "none" || len(body.RedirectURIs) != 1 || !strings.HasPrefix(body.RedirectURIs[0], "http://127.0.0.1:") {
			http.Error(w, "bad registration", 400)
			return
		}
		redirect = body.RedirectURIs[0]
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]string{"client_id": "cli-1"})
	})
	mux.HandleFunc("GET /authorize", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("redirect_uri") != redirect || q.Get("code_challenge_method") != "S256" || !strings.HasSuffix(q.Get("resource"), "/mcp") {
			http.Error(w, "bad authorize request", 400)
			return
		}
		challenge = q.Get("code_challenge")
		http.Redirect(w, r, redirect+"?code=the-code&state="+url.QueryEscape(q.Get("state")), http.StatusFound)
	})
	mux.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if r.Form.Get("code") != "the-code" || base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
				json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600})
		case "refresh_token":
			refreshes++
			if r.Form.Get("refresh_token") != "rt-1" {
				json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 3600})
		}
	})
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if a := r.Header.Get("Authorization"); a != "Bearer at-1" && a != "Bearer at-2" {
				http.Error(w, `{"error":"unauthorized"}`, 401)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("GET /mcp/api/me", auth(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(Me{Login: "octo", Workspaces: []Workspace{{Slug: "octo", Kind: "personal"}, {Slug: "acme", Kind: "team"}}})
	}))
	mux.HandleFunc("POST /mcp/api/workspaces/{slug}/git-credentials", auth(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(GitCredentials{URL: "https://abc.artifacts.example/git/ws-" + r.PathValue("slug") + ".git", Username: "x", Password: "art-" + r.PathValue("slug")})
	}))
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// browser follows the authorize URL like a browser: the redirect lands on
// the CLI's loopback server.
func browser(t *testing.T) func(string) {
	return func(u string) {
		go func() {
			resp, err := http.Get(u)
			if err != nil {
				t.Errorf("browser: %v", err)
				return
			}
			resp.Body.Close()
		}()
	}
}

func TestLoginAPIAndCredentialHelper(t *testing.T) {
	t.Setenv("MEMORY_GO_CLOUD_CREDENTIALS", filepath.Join(t.TempDir(), "cloud.json"))
	ctx := context.Background()
	srv := fakeServer(t)

	c, err := Login(ctx, srv.URL+"/", browser(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.AccessToken != "at-1" || c.RefreshToken != "rt-1" || c.URL != srv.URL || c.ClientID != "cli-1" {
		t.Fatalf("credentials = %+v", c)
	}
	me, err := c.Me(ctx)
	if err != nil || me.Login != "octo" || len(me.Workspaces) != 2 {
		t.Fatalf("Me = %+v, %v", me, err)
	}

	// An expired access token is refreshed and saved.
	c.ExpiresAt = time.Now().Add(-time.Minute)
	g, err := c.GitCredentials(ctx, "acme")
	if err != nil || g.Password != "art-acme" {
		t.Fatalf("GitCredentials = %+v, %v", g, err)
	}
	saved, err := Load()
	if err != nil || saved.AccessToken != "at-2" || saved.RefreshToken != "rt-2" {
		t.Fatalf("refreshed token not saved: %+v, %v", saved, err)
	}

	// The credential helper answers only for the workspace's git host.
	saved.Workspace, saved.GitURL = "acme", g.URL
	if err := saved.Save(); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	ok, err := CredentialHelper(ctx, map[string]string{"protocol": "https", "host": "abc.artifacts.example"}, &out)
	if !ok || err != nil || out.String() != "username=x\npassword=art-acme\n" {
		t.Fatalf("helper = %v, %v, %q", ok, err, out.String())
	}
	out.Reset()
	if ok, _ := CredentialHelper(ctx, map[string]string{"protocol": "https", "host": "github.com"}, &out); ok || out.Len() != 0 {
		t.Fatalf("helper answered for another host: %q", out.String())
	}
}

func TestLoginByPastingTheRedirect(t *testing.T) {
	t.Setenv("MEMORY_GO_CLOUD_CREDENTIALS", filepath.Join(t.TempDir(), "cloud.json"))
	srv := fakeServer(t)
	// Over SSH the redirect can't reach this machine: the user pastes the
	// address their browser ended up on.
	pasted := make(chan string, 1)
	open := func(u string) {
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		resp, err := client.Get(u)
		if err != nil {
			t.Error(err)
			return
		}
		resp.Body.Close()
		pasted <- resp.Header.Get("Location") + "\n"
	}
	r, w := io.Pipe()
	go func() { w.Write([]byte(<-pasted)); w.Close() }()
	c, err := Login(context.Background(), srv.URL, open, r)
	if err != nil || c.AccessToken != "at-1" {
		t.Fatalf("Login = %+v, %v", c, err)
	}
}
