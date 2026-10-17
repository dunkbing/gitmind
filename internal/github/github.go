// Package github logs in to GitHub with the OAuth device flow, stores the
// token, and talks to the few REST endpoints memory-go needs.
package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Client talks to GitHub. The zero value isn't usable; use New.
type Client struct {
	ClientID string // OAuth App client ID (public)
	WebURL   string // https://github.com, overridable for tests
	APIURL   string // https://api.github.com
	HTTP     *http.Client
	Token    string
	PollUnit time.Duration // one second; shortened in tests
}

func New(clientID, token string) *Client {
	return &Client{
		ClientID: clientID,
		WebURL:   "https://github.com",
		APIURL:   "https://api.github.com",
		HTTP:     &http.Client{Timeout: 30 * time.Second},
		Token:    token,
		PollUnit: time.Second,
	}
}

// DeviceCode is what the user needs to approve a login.
type DeviceCode struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
}

// StartLogin begins the device flow, asking for the "repo" scope: read and
// write access to private repositories, which the notes repo needs.
func (c *Client) StartLogin(ctx context.Context) (DeviceCode, error) {
	var dc DeviceCode
	if c.ClientID == "" {
		return dc, errors.New("no GitHub OAuth client ID configured; set MEMORY_GO_GITHUB_CLIENT_ID")
	}
	err := c.postForm(ctx, c.WebURL+"/login/device/code", url.Values{
		"client_id": {c.ClientID},
		"scope":     {"repo"},
	}, &dc)
	if err == nil && dc.DeviceCode == "" {
		err = errors.New("GitHub returned no device code; is device flow enabled for the OAuth App?")
	}
	return dc, err
}

// WaitForLogin polls until the user approves the device code, then returns
// the access token.
func (c *Client) WaitForLogin(ctx context.Context, dc DeviceCode) (string, error) {
	interval := time.Duration(max(dc.Interval, 1)) * c.PollUnit
	deadline := time.Now().Add(time.Duration(dc.ExpiresIn) * c.PollUnit)
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(interval):
		}
		var resp struct {
			AccessToken string `json:"access_token"`
			Error       string `json:"error"`
			Interval    int    `json:"interval"`
		}
		err := c.postForm(ctx, c.WebURL+"/login/oauth/access_token", url.Values{
			"client_id":   {c.ClientID},
			"device_code": {dc.DeviceCode},
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
		}, &resp)
		if err != nil {
			return "", err
		}
		switch resp.Error {
		case "":
			if resp.AccessToken == "" {
				return "", errors.New("GitHub returned no access token")
			}
			return resp.AccessToken, nil
		case "authorization_pending":
		case "slow_down":
			interval = time.Duration(max(resp.Interval, int(interval/c.PollUnit)+5)) * c.PollUnit
		case "expired_token":
			return "", errors.New("the code expired before it was approved; run `memory-go auth login` again")
		case "access_denied":
			return "", errors.New("the login was denied on GitHub")
		default:
			return "", fmt.Errorf("GitHub login failed: %s", resp.Error)
		}
		if dc.ExpiresIn > 0 && time.Now().After(deadline) {
			return "", errors.New("the code expired before it was approved; run `memory-go auth login` again")
		}
	}
}

type User struct {
	Login string `json:"login"`
}

func (c *Client) User(ctx context.Context) (User, error) {
	var u User
	return u, c.api(ctx, http.MethodGet, "/user", nil, &u)
}

type Repo struct {
	FullName string `json:"full_name"`
	Private  bool   `json:"private"`
	CloneURL string `json:"clone_url"`
	HTMLURL  string `json:"html_url"`
}

// ErrNotFound is returned for missing repositories (and ones the token can't
// see).
var ErrNotFound = errors.New("not found")

func (c *Client) Repo(ctx context.Context, fullName string) (Repo, error) {
	var r Repo
	return r, c.api(ctx, http.MethodGet, "/repos/"+fullName, nil, &r)
}

// CreateRepo creates a repository owned by the logged-in user.
func (c *Client) CreateRepo(ctx context.Context, name string, private bool) (Repo, error) {
	var r Repo
	return r, c.api(ctx, http.MethodPost, "/user/repos", map[string]any{
		"name":        name,
		"private":     private,
		"description": "Agent memory notes, synced by memory-go",
	}, &r)
}

func (c *Client) api(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(data))
	}
	req, err := http.NewRequestWithContext(ctx, method, c.APIURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return ErrNotFound
	case resp.StatusCode == http.StatusUnauthorized:
		return errors.New("GitHub rejected the saved login; run `memory-go auth login` again")
	case resp.StatusCode >= 300:
		var e struct {
			Message string `json:"message"`
		}
		json.Unmarshal(data, &e)
		return fmt.Errorf("GitHub %s %s: %s %s", method, path, resp.Status, e.Message)
	}
	return json.Unmarshal(data, out)
}

func (c *Client) postForm(ctx context.Context, endpoint string, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("GitHub %s: %s %s", endpoint, resp.Status, strings.TrimSpace(string(data)))
	}
	return json.Unmarshal(data, out)
}

// Credentials is the saved login.
type Credentials struct {
	Login string `json:"login"`
	Token string `json:"token"`
}

// CredentialsPath is where the login is saved: a file only the user can
// read, in the user's config directory.
func CredentialsPath() (string, error) {
	if p := os.Getenv("MEMORY_GO_CREDENTIALS"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "memory-go", "github.json"), nil
}

func LoadCredentials() (Credentials, error) {
	var c Credentials
	p, err := CredentialsPath()
	if err != nil {
		return c, err
	}
	data, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return c, errors.New("not logged in to GitHub; run `memory-go auth login`")
	} else if err != nil {
		return c, err
	}
	return c, json.Unmarshal(data, &c)
}

func SaveCredentials(c Credentials) error {
	p, err := CredentialsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func DeleteCredentials() error {
	p, err := CredentialsPath()
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// CredentialHelper implements git's credential helper protocol for the
// saved login: for "get" on https://github.com it answers with the token;
// everything else is left to other helpers. See gitcredentials(7).
func CredentialHelper(op string, in io.Reader, out io.Writer) error {
	if op != "get" {
		io.Copy(io.Discard, in)
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(in, 1<<16))
	if err != nil {
		return err
	}
	attrs := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
			attrs[k] = v
		}
	}
	if attrs["protocol"] != "https" || attrs["host"] != "github.com" {
		return nil
	}
	creds, err := LoadCredentials()
	if err != nil || creds.Token == "" {
		return nil // let git try other helpers or fail with its own message
	}
	_, err = fmt.Fprintf(out, "username=%s\npassword=%s\n", creds.Login, creds.Token)
	return err
}
