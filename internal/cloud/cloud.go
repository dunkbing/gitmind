// Package cloud connects the CLI to a memory-go cloud server: it signs in
// with OAuth (dynamic client registration, PKCE and a loopback redirect, as
// RFC 8252 describes for native apps), stores the login, and fetches
// short-lived git credentials for a workspace's repository.
package cloud

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Credentials is the saved cloud login and the workspace this machine syncs.
type Credentials struct {
	URL          string    `json:"url"`
	ClientID     string    `json:"client_id"`
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	ExpiresAt    time.Time `json:"expires_at"`
	Login        string    `json:"login"`
	Workspace    string    `json:"workspace"`
	GitURL       string    `json:"git_url"`
}

func Path() (string, error) {
	if p := os.Getenv("MEMORY_GO_CLOUD_CREDENTIALS"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "memory-go", "cloud.json"), nil
}

func Load() (*Credentials, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("not connected to a memory-go cloud; run `memory-go setup --cloud URL`")
	} else if err != nil {
		return nil, err
	}
	var c Credentials
	return &c, json.Unmarshal(data, &c)
}

func (c *Credentials) Save() error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func Delete() error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

var httpClient = &http.Client{Timeout: 30 * time.Second}

type token struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Error        string `json:"error"`
	Description  string `json:"error_description"`
}

// Login signs in to the server at base. open is called with the URL the
// user must visit; prompt, when non-nil, lets the user paste the address
// their browser was redirected to instead (for SSH sessions, where the
// redirect can't reach this machine).
func Login(ctx context.Context, base string, open func(string), prompt io.Reader) (*Credentials, error) {
	base = strings.TrimRight(base, "/")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	defer ln.Close()
	redirect := fmt.Sprintf("http://127.0.0.1:%d/callback", ln.Addr().(*net.TCPAddr).Port)

	clientID, err := register(ctx, base, redirect)
	if err != nil {
		return nil, err
	}
	verifier := randomString(32)
	sum := sha256.Sum256([]byte(verifier))
	state := randomString(16)
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {clientID},
		"redirect_uri":          {redirect},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(sum[:])},
		"code_challenge_method": {"S256"},
		"state":                 {state},
		"scope":                 {"memory offline_access"},
		"resource":              {base + "/mcp"},
	}

	results := make(chan url.Values, 2)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/callback" {
			http.NotFound(w, r)
			return
		}
		results <- r.URL.Query()
		fmt.Fprintln(w, "memory-go is signed in. You can close this tab and return to the terminal.")
	})}
	go srv.Serve(ln)
	defer srv.Close()
	if prompt != nil {
		go func() {
			line, err := bufio.NewReader(prompt).ReadString('\n')
			if err != nil {
				return
			}
			if u, err := url.Parse(strings.TrimSpace(line)); err == nil {
				results <- u.Query()
			}
		}()
	}

	open(base + "/authorize?" + q.Encode())
	var got url.Values
	select {
	case got = <-results:
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(10 * time.Minute):
		return nil, errors.New("timed out waiting for sign-in")
	}
	if e := got.Get("error"); e != "" {
		if e == "access_denied" {
			return nil, errors.New("sign-in was denied")
		}
		return nil, fmt.Errorf("sign-in failed: %s %s", e, got.Get("error_description"))
	}
	if got.Get("state") != state {
		return nil, errors.New("sign-in failed: the response doesn't match this request (state mismatch)")
	}

	t, err := postToken(ctx, base, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {got.Get("code")},
		"redirect_uri":  {redirect},
		"client_id":     {clientID},
		"code_verifier": {verifier},
		"resource":      {base + "/mcp"},
	})
	if err != nil {
		return nil, err
	}
	c := &Credentials{URL: base, ClientID: clientID}
	c.setToken(t)
	return c, nil
}

func register(ctx context.Context, base, redirect string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"client_name":                "memory-go CLI",
		"redirect_uris":              []string{redirect},
		"token_endpoint_auth_method": "none",
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/oauth/register", strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("can't reach %s: %w", base, err)
	}
	defer resp.Body.Close()
	var out struct {
		ClientID string `json:"client_id"`
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 || json.Unmarshal(data, &out) != nil || out.ClientID == "" {
		return "", fmt.Errorf("%s doesn't look like a memory-go cloud (registration: %s)", base, resp.Status)
	}
	return out.ClientID, nil
}

func postToken(ctx context.Context, base string, form url.Values) (token, error) {
	var t token
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return t, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClient.Do(req)
	if err != nil {
		return t, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err := json.Unmarshal(data, &t); err != nil {
		return t, fmt.Errorf("token endpoint: %s", resp.Status)
	}
	if t.Error != "" || t.AccessToken == "" {
		return t, fmt.Errorf("token endpoint: %s %s", t.Error, t.Description)
	}
	return t, nil
}

func (c *Credentials) setToken(t token) {
	c.AccessToken = t.AccessToken
	if t.RefreshToken != "" {
		c.RefreshToken = t.RefreshToken
	}
	c.ExpiresAt = time.Now().Add(time.Duration(max(t.ExpiresIn, 60)) * time.Second)
}

// Fresh makes sure the access token is valid for at least another minute,
// refreshing (and saving) it when needed.
func (c *Credentials) Fresh(ctx context.Context) error {
	if time.Until(c.ExpiresAt) > time.Minute {
		return nil
	}
	if c.RefreshToken == "" {
		return errors.New("the cloud login expired; run `memory-go setup --cloud` again")
	}
	t, err := postToken(ctx, c.URL, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {c.RefreshToken},
		"client_id":     {c.ClientID},
		"resource":      {c.URL + "/mcp"},
	})
	if err != nil {
		return fmt.Errorf("the cloud login expired (%v); run `memory-go setup --cloud` again", err)
	}
	c.setToken(t)
	return c.Save()
}

type Workspace struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
	Kind string `json:"kind"`
	Role string `json:"role"`
}

type Me struct {
	Login      string      `json:"login"`
	Workspaces []Workspace `json:"workspaces"`
}

func (c *Credentials) Me(ctx context.Context) (Me, error) {
	var me Me
	return me, c.api(ctx, http.MethodGet, "/mcp/api/me", &me)
}

type GitCredentials struct {
	URL       string    `json:"url"`
	Username  string    `json:"username"`
	Password  string    `json:"password"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// GitCredentials gets a short-lived git token for the workspace's repository.
func (c *Credentials) GitCredentials(ctx context.Context, slug string) (GitCredentials, error) {
	var g GitCredentials
	return g, c.api(ctx, http.MethodPost, "/mcp/api/workspaces/"+url.PathEscape(slug)+"/git-credentials", &g)
}

func (c *Credentials) api(ctx context.Context, method, path string, out any) error {
	if err := c.Fresh(ctx); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, c.URL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.AccessToken)
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		json.Unmarshal(data, &e)
		if resp.StatusCode == http.StatusUnauthorized {
			return errors.New("the cloud rejected the saved login; run `memory-go setup --cloud` again")
		}
		return fmt.Errorf("%s %s: %s %s", method, path, resp.Status, e.Error)
	}
	return json.Unmarshal(data, out)
}

// CredentialHelper answers git's credential "get" for the cloud
// workspace's repository host. It reports whether it answered, so other
// helpers (e.g. GitHub) can be tried.
func CredentialHelper(ctx context.Context, attrs map[string]string, out io.Writer) (bool, error) {
	c, err := Load()
	if err != nil || c.GitURL == "" {
		return false, nil
	}
	remote, err := url.Parse(c.GitURL)
	if err != nil || attrs["host"] != remote.Host || attrs["protocol"] != remote.Scheme {
		return false, nil
	}
	g, err := c.GitCredentials(ctx, c.Workspace)
	if err != nil {
		return false, err
	}
	_, err = fmt.Fprintf(out, "username=%s\npassword=%s\n", g.Username, g.Password)
	return true, err
}

func randomString(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
