package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strings"

	"github.com/dunkbing/gitmind/internal/cloud"
	"github.com/dunkbing/gitmind/internal/github"
	"github.com/dunkbing/gitmind/internal/gitsync"
	"github.com/dunkbing/gitmind/internal/memory"
)

// githubClientID is the public client ID of the gitmind GitHub OAuth App,
// public by design (device flow needs no secret); override with
// GITMIND_GITHUB_CLIENT_ID.
var githubClientID = "Ov23liPvy5PXJaaqYI4N"

func clientID() string {
	if id := os.Getenv("GITMIND_GITHUB_CLIENT_ID"); id != "" {
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
		if _, err := readLine(ctx, stdin); err != nil {
			return github.Credentials{}, err
		}
		if err := github.OpenBrowser(dc.VerificationURI); err != nil {
			fmt.Printf("Couldn't open a browser; open %s yourself.\n", dc.VerificationURI)
		}
	} else {
		fmt.Printf("Open %s on any device and enter the code.\n", dc.VerificationURI)
	}
	fmt.Println("Waiting for you to approve gitmind on GitHub...")
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
	agents, err := setupNotes(ctx, dir, args)
	if err != nil || !agents.enabled {
		return err
	}
	a, err := newAgentSetup(agents.assumeYes)
	if err != nil {
		return err
	}
	return a.Run(ctx)
}

type agentChoice struct{ enabled, assumeYes bool }

// setupNotes connects the notes directory to where the notes live, and
// reports whether to go on to configure the coding agents.
func setupNotes(ctx context.Context, dir string, args []string) (agentChoice, error) {
	fs := flag.NewFlagSet("setup", flag.ExitOnError)
	server := fs.String("server", defaultServer(), "gitmind server to sync with; set it for a self-hosted server")
	workspace := fs.String("workspace", "", "workspace to sync (default: your personal one)")
	useGitHub := fs.Bool("github", false, "sync with a repository on your GitHub account instead of a gitmind server")
	local := fs.Bool("local", false, "keep notes on this computer only, without syncing")
	yes := fs.Bool("yes", false, "add gitmind to Claude Code and Codex without asking")
	noAgents := fs.Bool("no-agents", false, "don't offer to add gitmind to Claude Code and Codex")
	name := fs.String("repo", "gitmind-notes", "with --github: NAME under your account, or OWNER/NAME")
	public := fs.Bool("public", false, "with --github: create the repository as public (default private)")
	fs.Parse(args)
	choice := agentChoice{enabled: !*noAgents, assumeYes: *yes}

	// Flags decide; otherwise ask in a terminal, and default to the cloud in
	// scripts.
	provider := providerCloud
	serverSet := false
	fs.Visit(func(f *flag.Flag) { serverSet = serverSet || f.Name == "server" })
	switch {
	case *local:
		provider = providerLocal
	case *useGitHub:
		provider = providerGitHub
	case serverSet:
		provider = providerServer
	case isTerminal():
		p, u, err := chooseProvider(ctx, stdin, os.Stdout)
		if err != nil {
			return agentChoice{}, err
		}
		provider = p
		if u != "" {
			*server = u
		}
	}
	switch provider {
	case providerLocal:
		if !gitsync.IsRepo(dir) {
			if err := gitsync.Init(ctx, dir, ""); err != nil {
				return agentChoice{}, err
			}
		}
		fmt.Printf("✓ Notes are in %s, on this computer only.\n", dir)
		fmt.Println("  Run `gitmind setup` again any time to start syncing them.")
		return choice, nil
	case providerCloud:
		return choice, cloudSetup(ctx, dir, defaultServer(), *workspace, confirmer(ctx, *yes))
	case providerServer:
		return choice, cloudSetup(ctx, dir, *server, *workspace, confirmer(ctx, *yes))
	}

	creds, err := github.LoadCredentials()
	if err == nil {
		// Make sure the saved login still works before relying on it.
		if _, err = github.New(clientID(), creds.Token).User(ctx); err != nil {
			fmt.Println("The saved GitHub login no longer works; logging in again.")
		}
	}
	if err != nil {
		if creds, err = login(ctx); err != nil {
			return agentChoice{}, err
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return agentChoice{}, err
	}
	repo, created, err := connectRepo(ctx, github.New(clientID(), creds.Token), creds.Login, *name, !*public, dir, credentialHelperConfig(exe), confirmer(ctx, *yes))
	if err != nil {
		return agentChoice{}, err
	}
	if created {
		fmt.Printf("✓ Created %s repository %s\n", visibility(repo.Private), repo.HTMLURL)
	} else {
		fmt.Printf("✓ Connected to %s\n", repo.HTMLURL)
	}
	fmt.Printf("✓ Notes are in %s and sync with GitHub automatically.\n", dir)
	fmt.Println("\nNext, add gitmind to your agents (see the README):")
	fmt.Println("  claude mcp add --scope user gitmind -- gitmind")
	return choice, nil
}

// connectRepo finds or creates the GitHub repository and makes dir a clone of
// it that authenticates through gitmind. It reports whether the repository
// was created.
func connectRepo(ctx context.Context, gh *github.Client, login, name string, private bool, dir string, config []string, confirm confirmFunc) (github.Repo, bool, error) {
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

	return repo, created, attachRepo(ctx, dir, repo.CloneURL, config, confirm)
}

// confirmFunc asks the user a yes/no question.
type confirmFunc func(question string) (bool, error)

// confirmer asks on the terminal (default yes), answers yes with --yes, and
// no when there's no terminal to ask on.
func confirmer(ctx context.Context, assumeYes bool) confirmFunc {
	return func(question string) (bool, error) {
		if assumeYes {
			return true, nil
		}
		if !isTerminal() {
			return false, nil
		}
		for {
			fmt.Printf("%s [Y/n] ", question)
			answer, err := readLine(ctx, stdin)
			if err != nil {
				return false, err
			}
			switch strings.ToLower(answer) {
			case "", "y", "yes":
				return true, nil
			case "n", "no":
				return false, nil
			}
		}
	}
}

// attachRepo makes dir a clone of remote, or points an existing notes
// repository at it and merges the two, with config (a credential helper)
// stored in the repository. A repository that already syncs with another
// remote is switched over only if confirm agrees; see switchRepo.
func attachRepo(ctx context.Context, dir, remote string, config []string, confirm confirmFunc) error {
	if !gitsync.IsRepo(dir) {
		return gitsync.Init(ctx, dir, remote, config...)
	}
	r := &gitsync.Repo{Dir: dir}
	if current := r.Remote(ctx); current != "" && !sameRepoURL(current, remote) {
		ok, err := confirm(fmt.Sprintf("%s already syncs with %s.\nSwitch it to the new location? Your notes are kept: the folder is backed up, and notes the new location doesn't have are copied over.", dir, displayRemote(current)))
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("%s already syncs with %s; run setup again and choose to switch, or use --dir for a separate notes folder", dir, displayRemote(current))
		}
		return switchRepo(ctx, dir, remote, config)
	}
	if err := r.SetRemote(ctx, remote); err != nil {
		return err
	}
	if err := gitsync.Configure(ctx, dir, config...); err != nil {
		return err
	}
	app, err := memory.Open(dir, log.Default())
	if err != nil {
		return err
	}
	defer app.Close()
	_, err = app.Sync(ctx)
	return err
}

// credentialHelperConfig makes git ask gitmind for github.com credentials
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

// defaultServer is gitmind.app, unless GITMIND_SERVER names another (e.g. a
// self-hosted) server.
func defaultServer() string {
	if s := os.Getenv("GITMIND_SERVER"); s != "" {
		return s
	}
	return "https://gitmind.app"
}

// cloudSetup signs in to a gitmind cloud server and makes dir a synced
// clone of one of its workspaces. Git authenticates through gitmind, which
// fetches short-lived tokens from the server.
func cloudSetup(ctx context.Context, dir, base, slug string, confirm confirmFunc) error {
	base = strings.TrimRight(base, "/")
	creds, err := cloud.Load()
	if err == nil && creds.URL == base {
		err = creds.Fresh(ctx)
	} else if err == nil {
		err = errors.New("different server")
	}
	if err != nil {
		if creds, err = cloudLogin(ctx, base); err != nil {
			return err
		}
	}
	me, err := creds.Me(ctx)
	if err != nil {
		return err
	}
	var ws *cloud.Workspace
	for i, w := range me.Workspaces {
		if (slug == "" && w.Kind == "personal") || strings.EqualFold(w.Slug, slug) {
			ws = &me.Workspaces[i]
			break
		}
	}
	if ws == nil {
		var names []string
		for _, w := range me.Workspaces {
			names = append(names, w.Slug)
		}
		return fmt.Errorf("no workspace %q; yours are: %s", slug, strings.Join(names, ", "))
	}
	g, err := creds.GitCredentials(ctx, ws.Slug)
	if err != nil {
		return err
	}
	creds.Login, creds.Workspace, creds.GitURL = me.Login, ws.Slug, g.URL
	if err := creds.Save(); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	// The notes repository talks only to the cloud, so a repository-wide
	// helper is enough; the empty value clears global helpers first.
	config := []string{"credential.helper=", "credential.helper=!'" + strings.ReplaceAll(exe, "'", `'\''`) + "' credential"}
	if err := attachRepo(ctx, dir, g.URL, config, confirm); err != nil {
		return err
	}
	fmt.Printf("✓ Connected to workspace %s (%s) on %s as %s\n", ws.Slug, ws.Name, base, me.Login)
	fmt.Printf("✓ Notes are in %s and sync with the cloud automatically.\n", dir)
	fmt.Println("\nAI apps that can't run gitmind locally (claude.ai, ChatGPT, mobile) can use the same memory at:")
	fmt.Printf("  %s/mcp\n", base)
	return nil
}

func cloudLogin(ctx context.Context, base string) (*cloud.Credentials, error) {
	interactive := github.CanOpenBrowser()
	open := func(u string) {
		if interactive {
			fmt.Println("Opening your browser to sign in to", base)
			if github.OpenBrowser(u) == nil {
				return
			}
		}
		fmt.Printf("Open this link in a browser and approve gitmind:\n\n  %s\n\n", u)
		fmt.Println("If the browser then fails to load a 127.0.0.1 page (e.g. over SSH), copy that page's full address and paste it here.")
	}
	var prompt io.Reader
	if !interactive {
		prompt = stdin
	}
	c, err := cloud.Login(ctx, base, open, prompt)
	if err != nil {
		return nil, err
	}
	fmt.Println("✓ Signed in to", base)
	return c, nil
}
