// Command gitmind is a git-backed memory server for coding agents. It runs
// as a local MCP server over stdio and keeps notes in sync between machines
// through a git remote such as a private GitHub repository.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/dunkbing/gitmind/internal/cloud"
	"github.com/dunkbing/gitmind/internal/github"
	"github.com/dunkbing/gitmind/internal/gitsync"
	"github.com/dunkbing/gitmind/internal/hooks"
	"github.com/dunkbing/gitmind/internal/index"
	"github.com/dunkbing/gitmind/internal/memory"
	"github.com/dunkbing/gitmind/internal/notes"
	"github.com/dunkbing/gitmind/internal/server"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var version = "0.1.0-dev"

const usage = `gitmind: git-backed memory for coding agents

Usage:
  gitmind [--dir DIR] [--sync-interval 3m] [command] [args]

Commands:
  setup              choose where to keep your notes (gitmind.app, GitHub, a
                     self-hosted server, or this computer) and connect them
                       --server URL    a self-hosted gitmind server instead
                                       (or set GITMIND_SERVER)
                       --workspace S   a team workspace (default: personal)
                       --github        sync with a private repository on your
                                       GitHub account instead of a server
                       --local         keep notes on this computer only
                     Without these, setup asks where to keep the notes. It then
                     offers to add gitmind to Claude Code and Codex (--yes
                     accepts, --no-agents skips).
  agents             add gitmind to Claude Code and Codex: MCP server, Claude
                     Code hooks, and memory instructions (asks first; --yes)
                       --repo NAME     with --github: NAME or OWNER/NAME
                                       (default gitmind-notes)
                       --public        with --github: create it public
  auth login|status|logout
                     manage the GitHub login used by setup --github
  serve              run the MCP server on stdio (default)
  context            print memory for the current project, for a SessionStart
                     hook (reads the hook's JSON from stdin when piped)
                       --cwd DIR       project directory (default: hook cwd, else .)
                       --project NAME  memory directory to use instead
                       --budget BYTES  rough size limit (default 8000)
  nudge              for a Stop hook: after substantial work with no memory
                     write, remind the agent once to save what it learned
                       --threshold N   tool calls that count as substantial (default 10)
  init [REMOTE]      create the notes repository, cloning REMOTE when given;
                     on an existing repository, adds REMOTE as origin
  sync               commit local edits, pull and push
  reindex            rebuild the search index from the notes on disk
  search QUERY...    search notes
  recent [N]         list the N most recently changed notes (default 10)
  version            print the version

The notes directory defaults to $GITMIND_DIR, or ~/.gitmind.
`

func main() {
	log.SetFlags(0)
	log.SetPrefix("gitmind: ")
	flag.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	dir := flag.String("dir", defaultDir(), "notes repository directory")
	interval := flag.Duration("sync-interval", 3*time.Minute, "how often serve syncs in the background (0: only at startup)")
	flag.Parse()

	cmd, args := "serve", flag.Args()
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// The first Ctrl+C cancels ctx so commands can stop cleanly; after that
	// the default handling is back, so a second one always quits.
	context.AfterFunc(ctx, stop)

	var err error
	switch cmd {
	case "serve":
		err = serve(ctx, *dir, *interval)
	case "context":
		sessionContext(*dir, args)
	case "nudge":
		nudge(*dir, args)
	case "auth":
		err = authCmd(ctx, args)
	case "setup":
		err = setupCmd(ctx, *dir, args)
	case "agents":
		fs := flag.NewFlagSet("agents", flag.ExitOnError)
		yes := fs.Bool("yes", false, "make every change without asking")
		fs.Parse(args)
		var a *agentSetup
		if a, err = newAgentSetup(*yes); err == nil {
			err = a.Run(ctx)
		}
	case "credential":
		// git credential helper protocol; see credentialHelperConfig.
		if len(args) > 0 {
			err = credentialHelper(ctx, args[0])
		}
	case "init":
		err = initRepo(ctx, *dir, args)
	case "sync":
		err = withApp(*dir, func(app *memory.App) error {
			res, err := app.Sync(ctx)
			fmt.Println(res)
			return err
		})
	case "reindex":
		err = reindex(*dir)
	case "search":
		err = withApp(*dir, func(app *memory.App) error {
			hits, err := app.Index.Search(index.Query{Text: strings.Join(args, " "), Limit: 20})
			printHits(hits)
			return err
		})
	case "recent":
		n := 10
		if len(args) > 0 {
			if n, err = strconv.Atoi(args[0]); err != nil {
				log.Fatalf("recent: %q is not a number", args[0])
			}
		}
		err = withApp(*dir, func(app *memory.App) error {
			hits, err := app.Index.Recent(n)
			printHits(hits)
			return err
		})
	case "version":
		fmt.Println(version)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr)
		os.Exit(130) // interrupted (Ctrl+C), like other CLIs
	}
	if err != nil {
		log.Fatal(err)
	}
}

func serve(ctx context.Context, dir string, interval time.Duration) error {
	if !gitsync.IsRepo(dir) {
		log.Printf("creating a local notes repository at %s; run `gitmind init REMOTE` to sync it", dir)
		if err := gitsync.Init(ctx, dir, ""); err != nil {
			return err
		}
	}
	app, err := memory.Open(dir, log.Default())
	if err != nil {
		return err
	}
	defer app.Close()
	app.StartAutoSync(interval)
	return server.New(app, version).Run(ctx, &mcp.StdioTransport{})
}

// sessionContext prints the project's memory for a SessionStart hook. It
// never fails: a broken memory must not block an agent session, so problems
// go to stderr and the command exits 0 with whatever it could produce.
func sessionContext(dir string, args []string) {
	fs := flag.NewFlagSet("context", flag.ExitOnError)
	cwd := fs.String("cwd", "", "project directory")
	project := fs.String("project", "", "memory directory to use")
	budget := fs.Int("budget", 8000, "rough size limit in bytes")
	fs.Parse(args)

	if *cwd == "" {
		var input struct {
			Cwd string `json:"cwd"`
		}
		json.Unmarshal(hookInput(), &input)
		*cwd = input.Cwd
	}
	if *cwd == "" {
		*cwd, _ = os.Getwd()
	}
	name := *project
	if name == "" {
		name = memory.ProjectName(*cwd)
	} else if clean, err := notes.CleanDir(name); err == nil {
		name = clean
	}
	if !gitsync.IsRepo(dir) {
		log.Printf("no notes repository at %s; run `gitmind init`", dir)
		return
	}
	app, err := memory.Open(dir, log.Default())
	if err != nil {
		log.Print(err)
		return
	}
	defer app.Close()

	// Pull first so the session starts with notes saved on other machines,
	// but don't hold the session up for long.
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	if _, err := app.Sync(ctx); err != nil {
		log.Printf("sync failed, showing local notes: %v", err)
	}
	cancel()

	out, err := app.SessionContext(name, *budget)
	if err != nil {
		log.Print(err)
		return
	}
	// Claude Code truncates hook output past 10,000 characters to a short
	// preview, so never let the context get there.
	if r := []rune(out); len(r) > hookOutputLimit {
		out = string(r[:hookOutputLimit]) + "\n… (truncated; use search_notes for more)\n"
	}
	fmt.Print(out)
}

const hookOutputLimit = 9500

// nudge implements a Claude Code Stop hook. Like sessionContext it never
// fails the hook: problems go to stderr and the agent is allowed to stop.
func nudge(dir string, args []string) {
	fs := flag.NewFlagSet("nudge", flag.ExitOnError)
	threshold := fs.Int("threshold", 10, "tool calls since the last memory write that count as substantial work")
	fs.Parse(args)

	var input hooks.StopInput
	if err := json.Unmarshal(hookInput(), &input); err != nil {
		return
	}
	reason, err := hooks.Nudge(input, filepath.Join(dir, ".gitmind", "nudges"), *threshold)
	if err != nil {
		log.Print(err)
		return
	}
	if reason == "" {
		return
	}
	// additionalContext continues the session with non-error feedback.
	out, _ := json.Marshal(map[string]any{
		"hookSpecificOutput": map[string]string{"hookEventName": "Stop", "additionalContext": reason},
	})
	fmt.Println(string(out))
}

// hookInput reads the JSON a Claude Code hook receives on stdin, if stdin is
// piped, giving up after two seconds.
func hookInput() []byte {
	info, err := os.Stdin.Stat()
	if err != nil || info.Mode()&os.ModeCharDevice != 0 {
		return nil
	}
	done := make(chan []byte, 1)
	go func() {
		data, _ := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
		done <- data
	}()
	select {
	case data := <-done:
		return data
	case <-time.After(2 * time.Second):
		return nil
	}
}

// credentialHelper answers git's credential requests: the cloud workspace's
// repository first, then github.com.
func credentialHelper(ctx context.Context, op string) error {
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<16))
	if err != nil || op != "get" {
		return err
	}
	attrs := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok {
			attrs[k] = v
		}
	}
	if answered, err := cloud.CredentialHelper(ctx, attrs, os.Stdout); answered || err != nil {
		return err
	}
	return github.CredentialHelper(op, bytes.NewReader(data), os.Stdout)
}

func initRepo(ctx context.Context, dir string, args []string) error {
	remote := ""
	if len(args) > 0 {
		remote = args[0]
	}
	if err := gitsync.Init(ctx, dir, remote); err != nil {
		return err
	}
	fmt.Printf("Notes repository ready at %s\n", dir)
	if remote == "" {
		fmt.Println("No remote yet: add one with `gitmind init git@github.com:you/notes.git` to sync between machines.")
	}
	return nil
}

// reindex deletes the index so Open rebuilds it from scratch.
func reindex(dir string) error {
	file := filepath.Join(dir, ".gitmind", "index.db")
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Remove(file + suffix); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return withApp(dir, func(app *memory.App) error {
		hits, err := app.Index.List("")
		fmt.Printf("Indexed %d notes.\n", len(hits))
		return err
	})
}

func withApp(dir string, fn func(*memory.App) error) error {
	app, err := memory.Open(dir, log.Default())
	if err != nil {
		return err
	}
	defer app.Close()
	return fn(app)
}

func printHits(hits []index.Hit) {
	if len(hits) == 0 {
		fmt.Println("No notes.")
	}
	for _, h := range hits {
		fmt.Printf("%s  %-40s  %s\n", h.Modified.Format("2006-01-02"), h.Path, h.Title)
		if h.Snippet != "" {
			fmt.Printf("            %s\n", strings.Join(strings.Fields(h.Snippet), " "))
		}
	}
}

func defaultDir() string {
	if d := os.Getenv("GITMIND_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".gitmind"
	}
	return filepath.Join(home, ".gitmind")
}
