package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
)

// stdin is shared by every prompt, so lines typed ahead aren't lost between
// separate reads.
var stdin = bufio.NewReader(os.Stdin)

// readLine reads one line, giving up when ctx is cancelled (Ctrl+C).
func readLine(ctx context.Context, in *bufio.Reader) (string, error) {
	type result struct {
		line string
		err  error
	}
	ch := make(chan result, 1)
	go func() {
		line, err := in.ReadString('\n')
		ch <- result{line, err}
	}()
	select {
	case r := <-ch:
		if r.err != nil && r.line == "" {
			return "", r.err
		}
		return strings.TrimSpace(r.line), nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func isTerminal() bool {
	info, err := os.Stdin.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// Where setup can keep the notes.
const (
	providerCloud  = "cloud"
	providerGitHub = "github"
	providerServer = "server"
	providerLocal  = "local"
)

// chooseProvider asks where to keep the notes, returning the provider and,
// for a self-hosted server, its URL.
func chooseProvider(ctx context.Context, in *bufio.Reader, out io.Writer) (string, string, error) {
	fmt.Fprint(out, `Where should gitmind keep your notes?
  1) gitmind cloud (gitmind.app)  works in claude.ai, ChatGPT and mobile apps
  2) GitHub                       a private repository on your GitHub account
  3) Self-hosted server           your own gitmind deployment
  4) This computer only           no sync; you can add it later
`)
	for {
		fmt.Fprint(out, "Choose 1-4 [1]: ")
		answer, err := readLine(ctx, in)
		if err != nil {
			return "", "", err
		}
		switch strings.ToLower(answer) {
		case "", "1", "cloud":
			return providerCloud, "", nil
		case "2", "github":
			return providerGitHub, "", nil
		case "3", "server":
			for {
				fmt.Fprint(out, "Server URL (e.g. https://memory.example.com): ")
				u, err := readLine(ctx, in)
				if err != nil {
					return "", "", err
				}
				if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
					return providerServer, strings.TrimRight(u, "/"), nil
				}
				fmt.Fprintln(out, "Enter the server's full address, starting with https://")
			}
		case "4", "local":
			return providerLocal, "", nil
		}
		fmt.Fprintln(out, "Please answer 1, 2, 3 or 4.")
	}
}
