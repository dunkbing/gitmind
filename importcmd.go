package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/dunkbing/gitmind/internal/claudecode"
	"github.com/dunkbing/gitmind/internal/memory"
)

// claudeMemories finds the memories Claude Code saved on this machine.
func claudeMemories(home string) ([]claudecode.Memory, error) {
	return claudecode.Find(claudecode.ConfigDir(home), home)
}

// importClaudeCode copies Claude Code's memories into the notes at dir,
// after showing what it found and asking (ask nil: don't ask).
func importClaudeCode(ctx context.Context, dir string, mems []claudecode.Memory, out io.Writer, ask func(string) (bool, error), dryRun bool) error {
	if len(mems) == 0 {
		fmt.Fprintln(out, "Claude Code has no memories on this machine.")
		return nil
	}
	ns := claudecode.Notes(mems)
	byDir := map[string][]string{}
	for _, n := range ns {
		d := n.Path[:strings.LastIndex(n.Path, "/")]
		byDir[d] = append(byDir[d], n.Title)
	}
	dirs := make([]string, 0, len(byDir))
	for d := range byDir {
		dirs = append(dirs, d)
	}
	sort.Strings(dirs)
	fmt.Fprintf(out, "Claude Code saved %d memories on this machine:\n", len(ns))
	for _, d := range dirs {
		fmt.Fprintf(out, "  %s/: %s\n", d, strings.Join(byDir[d], ", "))
	}
	if dryRun {
		return nil
	}
	if ask != nil {
		ok, err := ask("Import them into gitmind, so they follow you to every machine and app?")
		if err != nil || !ok {
			return err
		}
	}
	return withApp(dir, func(app *memory.App) error {
		res, err := app.Import(ctx, "Claude Code", ns)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "✓ Imported %d memories", len(res.Written))
		if len(res.Skipped) > 0 {
			fmt.Fprintf(out, "; skipped %d:", len(res.Skipped))
			for p, why := range res.Skipped {
				fmt.Fprintf(out, "\n  %s (%s)", p, why)
			}
		}
		fmt.Fprintln(out)
		return nil
	})
}

func importCmd(ctx context.Context, dir string, args []string) error {
	if len(args) == 0 || args[0] != "claude-code" {
		return fmt.Errorf("usage: gitmind import claude-code [--dry-run] [--yes]")
	}
	var dryRun, yes bool
	for _, a := range args[1:] {
		switch a {
		case "--dry-run", "-n":
			dryRun = true
		case "--yes", "-y":
			yes = true
		default:
			return fmt.Errorf("unknown flag %s", a)
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	mems, err := claudeMemories(home)
	if err != nil {
		return err
	}
	var ask func(string) (bool, error)
	if !yes {
		if !isTerminal() {
			return fmt.Errorf("run it in a terminal to confirm, or pass --yes")
		}
		ask = func(q string) (bool, error) { return confirm(ctx, stdin, os.Stdout, q) }
	}
	return importClaudeCode(ctx, dir, mems, os.Stdout, ask, dryRun)
}
