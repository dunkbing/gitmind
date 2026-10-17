// Command memory-go is a git-backed memory server for coding agents. It runs
// as a local MCP server over stdio and keeps notes in sync between machines
// through a git remote such as a private GitHub repository.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/dunkbing/memory-go/internal/gitsync"
	"github.com/dunkbing/memory-go/internal/index"
	"github.com/dunkbing/memory-go/internal/memory"
	"github.com/dunkbing/memory-go/internal/server"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var version = "0.1.0-dev"

const usage = `memory-go: git-backed memory for coding agents

Usage:
  memory-go [--dir DIR] [command] [args]

Commands:
  serve              run the MCP server on stdio (default)
  init [REMOTE]      create the notes repository, cloning REMOTE when given;
                     on an existing repository, adds REMOTE as origin
  sync               commit local edits, pull and push
  reindex            rebuild the search index from the notes on disk
  search QUERY...    search notes
  recent [N]         list the N most recently changed notes (default 10)
  version            print the version

The notes directory defaults to $MEMORY_GO_DIR, or ~/.memory-go.
`

func main() {
	log.SetFlags(0)
	log.SetPrefix("memory-go: ")
	flag.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	dir := flag.String("dir", defaultDir(), "notes repository directory")
	flag.Parse()

	cmd, args := "serve", flag.Args()
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch cmd {
	case "serve":
		err = serve(ctx, *dir)
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
			hits, err := app.Index.Search(strings.Join(args, " "), "", 20)
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
	if err != nil {
		log.Fatal(err)
	}
}

func serve(ctx context.Context, dir string) error {
	if !gitsync.IsRepo(dir) {
		log.Printf("creating a local notes repository at %s; run `memory-go init REMOTE` to sync it", dir)
		if err := gitsync.Init(ctx, dir, ""); err != nil {
			return err
		}
	}
	app, err := memory.Open(dir, log.Default())
	if err != nil {
		return err
	}
	defer app.Close()

	syncCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	if res, err := app.Sync(syncCtx); err != nil {
		log.Printf("startup sync failed, continuing with local notes: %v", err)
	} else if len(res.Conflicts) > 0 {
		log.Print(res)
	}
	cancel()

	return server.New(app, version).Run(ctx, &mcp.StdioTransport{})
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
		fmt.Println("No remote yet: add one with `memory-go init git@github.com:you/notes.git` to sync between machines.")
	}
	return nil
}

// reindex deletes the index so Open rebuilds it from scratch.
func reindex(dir string) error {
	file := filepath.Join(dir, ".memory-go", "index.db")
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
	if d := os.Getenv("MEMORY_GO_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".memory-go"
	}
	return filepath.Join(home, ".memory-go")
}
