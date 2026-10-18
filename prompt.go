package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
	"golang.org/x/term"
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

// option is one answer in a menu.
type option struct {
	label, detail string
}

// choose asks the user to pick one of options, returning its index. On a
// terminal it's an interactive menu (arrow keys or j/k, Enter, / to filter);
// otherwise, as in scripts and tests, the answer is typed: a number, or the
// start of an option's label. def is the default answer.
func choose(ctx context.Context, in *bufio.Reader, out io.Writer, question string, options []option, def int) (int, error) {
	width := 0
	for _, o := range options {
		width = max(width, len([]rune(o.label)))
	}
	if interactive(in) {
		opts := make([]huh.Option[int], len(options))
		for i, o := range options {
			opts[i] = huh.NewOption(fmt.Sprintf("%-*s  %s", width, o.label, o.detail), i)
		}
		picked := def
		err := runField(ctx, huh.NewSelect[int]().Title(question).Options(opts...).Value(&picked))
		if err != nil {
			return 0, err
		}
		answered(out, question, options[picked].label)
		return picked, nil
	}
	fmt.Fprintln(out, question)
	for i, o := range options {
		fmt.Fprintf(out, "  %d) %-*s  %s\n", i+1, width, o.label, o.detail)
	}
	for {
		fmt.Fprintf(out, "Choose 1-%d [%d]: ", len(options), def+1)
		answer, err := readLine(ctx, in)
		if err != nil {
			return 0, err
		}
		if answer == "" {
			return def, nil
		}
		if n, err := strconv.Atoi(answer); err == nil && n >= 1 && n <= len(options) {
			return n - 1, nil
		}
		for i, o := range options {
			if strings.HasPrefix(strings.ToLower(o.label), strings.ToLower(answer)) {
				return i, nil
			}
		}
		fmt.Fprintf(out, "Please answer a number from 1 to %d.\n", len(options))
	}
}

// confirm asks a yes/no question, defaulting to yes. On a terminal it's a
// Yes/No toggle (arrow keys, or y/n to answer at once); otherwise the answer
// is typed.
func confirm(ctx context.Context, in *bufio.Reader, out io.Writer, question string) (bool, error) {
	if interactive(in) {
		yes := true
		if err := runField(ctx, huh.NewConfirm().Title(question).Affirmative("Yes").Negative("No").Value(&yes)); err != nil {
			return false, err
		}
		answered(out, question, map[bool]string{true: "Yes", false: "No"}[yes])
		return yes, nil
	}
	for {
		fmt.Fprintf(out, "%s [Y/n] ", question)
		answer, err := readLine(ctx, in)
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

// ask reads a line of text that valid accepts (nil accepts anything).
func ask(ctx context.Context, in *bufio.Reader, out io.Writer, question, placeholder string, valid func(string) error) (string, error) {
	if valid == nil {
		valid = func(string) error { return nil }
	}
	if interactive(in) {
		var answer string
		input := huh.NewInput().Title(question).Placeholder(placeholder).Value(&answer).
			Validate(func(s string) error { return valid(strings.TrimSpace(s)) })
		if err := runField(ctx, input); err != nil {
			return "", err
		}
		answer = strings.TrimSpace(answer)
		answered(out, question, answer)
		return answer, nil
	}
	for {
		fmt.Fprintf(out, "%s (e.g. %s): ", question, placeholder)
		answer, err := readLine(ctx, in)
		if err != nil {
			return "", err
		}
		if err := valid(answer); err != nil {
			fmt.Fprintln(out, err)
			continue
		}
		return answer, nil
	}
}

// interactive reports whether a prompt reading from in can draw a terminal
// UI: in is the real stdin, and both stdin and stdout are terminals.
func interactive(in *bufio.Reader) bool {
	return in == stdin && term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
}

// runField shows one huh field. Ctrl+C or Esc cancels, like a cancelled ctx.
func runField(ctx context.Context, field huh.Field) error {
	err := huh.NewForm(huh.NewGroup(field)).WithTheme(theme).WithShowHelp(true).RunWithContext(ctx)
	if errors.Is(err, huh.ErrUserAborted) {
		return context.Canceled
	}
	return err
}

// answered leaves the question and its answer on screen once the form,
// which clears itself, is done.
func answered(out io.Writer, question, answer string) {
	fmt.Fprintf(out, "%s %s %s\n", accentStyle.Render("✓"), question, accentStyle.Render(answer))
}

var accentStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("2")).Bold(true)

// theme is huh's base theme in gitmind's green.
var theme = huh.ThemeFunc(func(isDark bool) *huh.Styles {
	t := huh.ThemeBase(isDark)
	color := lipgloss.LightDark(isDark)
	accent := color(lipgloss.Color("#1f6b55"), lipgloss.Color("#6cc8a5"))
	muted := color(lipgloss.Color("#6b7570"), lipgloss.Color("#8a958f"))
	t.Focused.Base = t.Focused.Base.BorderForeground(accent)
	t.Focused.Card = t.Focused.Base
	t.Focused.Title = t.Focused.Title.Foreground(accent).Bold(true)
	t.Focused.Description = t.Focused.Description.Foreground(muted)
	t.Focused.SelectSelector = t.Focused.SelectSelector.Foreground(accent).SetString("❯ ")
	t.Focused.SelectedOption = t.Focused.SelectedOption.Foreground(accent)
	t.Focused.Option = t.Focused.Option.Foreground(muted)
	t.Focused.FocusedButton = t.Focused.FocusedButton.Foreground(lipgloss.Color("#ffffff")).Background(accent).Bold(true)
	t.Focused.BlurredButton = t.Focused.BlurredButton.Foreground(muted).Background(nil)
	t.Focused.TextInput.Prompt = t.Focused.TextInput.Prompt.Foreground(accent)
	t.Focused.TextInput.Cursor = t.Focused.TextInput.Cursor.Foreground(accent)
	t.Focused.ErrorIndicator = t.Focused.ErrorIndicator.Foreground(lipgloss.Color("1"))
	t.Focused.ErrorMessage = t.Focused.ErrorMessage.Foreground(lipgloss.Color("1"))
	t.Blurred = t.Focused
	t.Blurred.Base = t.Blurred.Base.BorderStyle(lipgloss.HiddenBorder())
	t.Blurred.Card = t.Blurred.Base
	return t
})

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
	providers := []string{providerCloud, providerGitHub, providerServer, providerLocal}
	i, err := choose(ctx, in, out, "Where should gitmind keep your notes?", []option{
		{"gitmind cloud (gitmind.app)", "works in claude.ai, ChatGPT and mobile apps"},
		{"GitHub", "a private repository on your GitHub account"},
		{"Self-hosted server", "your own gitmind deployment"},
		{"This computer only", "no sync; you can add it later"},
	}, 0)
	if err != nil {
		return "", "", err
	}
	if providers[i] != providerServer {
		return providers[i], "", nil
	}
	u, err := ask(ctx, in, out, "Server URL", "https://memory.example.com", func(u string) error {
		if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
			return nil
		}
		return errors.New("Enter the server's full address, starting with https://")
	})
	if err != nil {
		return "", "", err
	}
	return providerServer, strings.TrimRight(u, "/"), nil
}
