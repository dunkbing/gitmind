package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/dunkbing/memory-go/internal/github"
	"github.com/dunkbing/memory-go/internal/gitsync"
	"github.com/dunkbing/memory-go/internal/memory"
)

// githubClientID is the public client ID of the memory-go GitHub OAuth App,
// set at build time with -ldflags "-X main.githubClientID=...".
var githubClientID = ""

func clientID() string {
	if id := os.Getenv("MEMORY_GO_GITHUB_CLIENT_ID"); id != "" {
		return id
	}
	return githubClientID
}

func authCmd(ctx context.Context, args []string) error {
	sub := "status"
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "login":
		_, err := login(ctx)
		return err
	case "logout":
		if err := github.DeleteCredentials(); err != nil {
			return err
		}
		fmt.Println("Logged out of GitHub. (Revoke the token at https://github.com/settings/applications to be thorough.)")
		return nil
	case "status":
		creds, err := github.LoadCredentials()
		if err != nil {
			return err
		}
		u, err := github.New(clientID(), creds.Token).User(ctx)
		if err != nil {
			return err
		}
		fmt.Printf("Logged in to GitHub as %s\n", u.Login)
		return nil
	default:
		return fmt.Errorf("unknown auth command %q (use login, status or logout)", sub)
	}
}

// login runs GitHub's device flow the way gh does: copy the code, open the
// browser on Enter, then wait for approval.
func login(ctx context.Context) (github.Credentials, error) {
	c := github.New(clientID(), "")
	dc, err := c.StartLogin(ctx)
	if err != nil {
		return github.Credentials{}, err
	}
	copied := ""
	if github.CopyToClipboard(dc.UserCode) {
		copied = " (copied to your clipboard)"
	}
	fmt.Printf("! Your one-time code: %s%s\n", dc.UserCode, copied)
	if github.CanOpenBrowser() {
		fmt.Printf("Press Enter to open %s in your browser...", dc.VerificationURI)
		bufio.NewReader(os.Stdin).ReadString('\n')
		if err := github.OpenBrowser(dc.VerificationURI); err != nil {
			fmt.Printf("Couldn't open a browser; open %s yourself.\n", dc.VerificationURI)
		}
	} else {
		fmt.Printf("Open %s on any device and enter the code.\n", dc.VerificationURI)
	}
	fmt.Println("Waiting for you to approve memory-go on GitHub...")
	token, err := c.WaitForLogin(ctx, dc)
	if err != nil {
		return github.Credentials{}, err
	}
	c.Token = token
	u, err := c.User(ctx)
	if err != nil {
		return github.Credentials{}, err
	}
	creds := github.Credentials{Login: u.Login, Token: token}
	if err := github.SaveCredentials(creds); err != nil {
		return github.Credentials{}, err
	}
	fmt.Printf("✓ Logged in to GitHub as %s\n", u.Login)
	return creds, nil
}

// setupCmd logs in if needed, then connects the notes directory to a GitHub
// repository, creating it (private) when it doesn't exist yet.
func setupCmd(ctx context.Context, dir string, args []string) error {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	name := fs.String("repo", "memory-notes", "notes repository: NAME under your account, or OWNER/NAME")
	public := fs.Bool("public", false, "create the repository as public (default private)")
	fs.Parse(args)

	creds, err := github.LoadCredentials()
	if err == nil {
		// Make sure the saved login still works before relying on it.
		if _, err = github.New(clientID(), creds.Token).User(ctx); err != nil {
			fmt.Println("The saved GitHub login no longer works; logging in again.")
		}
	}
	if err != nil {
		if creds, err = login(ctx); err != nil {
			return err
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	repo, created, err := connectRepo(ctx, github.New(clientID(), creds.Token), creds.Login, *name, !*public, dir, credentialHelperConfig(exe))
	if err != nil {
		return err
	}
	if created {
		fmt.Printf("✓ Created %s repository %s\n", visibility(repo.Private), repo.HTMLURL)
	} else {
		fmt.Printf("✓ Connected to %s\n", repo.HTMLURL)
	}
	fmt.Printf("✓ Notes are in %s and sync with GitHub automatically.\n", dir)
	fmt.Println("\nNext, add memory-go to your agents (see the README):")
	fmt.Println("  claude mcp add --scope user memory-go -- memory-go")
	return nil
}

// connectRepo finds or creates the GitHub repository and makes dir a clone of
// it that authenticates through memory-go. It reports whether the repository
// was created.
func connectRepo(ctx context.Context, gh *github.Client, login, name string, private bool, dir string, config []string) (github.Repo, bool, error) {
	full := name
	if !strings.Contains(full, "/") {
		full = login + "/" + name
	}
	owner, repoName, _ := strings.Cut(full, "/")
	repo, err := gh.Repo(ctx, full)
	created := false
	switch {
	case errors.Is(err, github.ErrNotFound):
		if !strings.EqualFold(owner, login) {
			return repo, false, fmt.Errorf("%s doesn't exist or you can't access it; create it on GitHub first", full)
		}
		if repo, err = gh.CreateRepo(ctx, repoName, private); err != nil {
			return repo, false, err
		}
		created = true
	case err != nil:
		return repo, false, err
	}

	if !gitsync.IsRepo(dir) {
		return repo, created, gitsync.Init(ctx, dir, repo.CloneURL, config...)
	}
	// An existing notes repository: point it at GitHub and merge the two.
	r := &gitsync.Repo{Dir: dir}
	if current := r.Remote(ctx); current != "" && !sameRepoURL(current, repo.CloneURL) {
		return repo, created, fmt.Errorf("%s already syncs with %s; use --dir to set up a different directory", dir, current)
	}
	if err := r.SetRemote(ctx, repo.CloneURL); err != nil {
		return repo, created, err
	}
	if err := gitsync.Configure(ctx, dir, config...); err != nil {
		return repo, created, err
	}
	app, err := memory.Open(dir, log.Default())
	if err != nil {
		return repo, created, err
	}
	defer app.Close()
	_, err = app.Sync(ctx)
	return repo, created, err
}

// credentialHelperConfig makes git ask memory-go for github.com credentials
// in the notes repository only; the empty value first clears helpers from
// the user's global config for that host.
func credentialHelperConfig(exe string) []string {
	key := "credential.https://github.com.helper"
	return []string{key + "=", key + "=!'" + strings.ReplaceAll(exe, "'", `'\''`) + "' credential"}
}

func sameRepoURL(a, b string) bool {
	norm := func(u string) string {
		u = strings.TrimSuffix(strings.TrimSuffix(strings.ToLower(u), "/"), ".git")
		u = strings.TrimPrefix(u, "https://")
		u = strings.TrimPrefix(u, "git@")
		return strings.Replace(u, "github.com:", "github.com/", 1)
	}
	return norm(a) == norm(b)
}

func visibility(private bool) string {
	if private {
		return "private"
	}
	return "public"
}
