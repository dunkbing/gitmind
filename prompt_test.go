package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestChooseProvider(t *testing.T) {
	cases := []struct {
		input, provider, server string
	}{
		{"\n", providerCloud, ""},
		{"1\n", providerCloud, ""},
		{"2\n", providerGitHub, ""},
		{"github\n", providerGitHub, ""},
		{"4\n", providerLocal, ""},
		{"7\nnope\n3\nmemory.example.com\nhttps://memory.example.com/\n", providerServer, "https://memory.example.com"},
	}
	for _, c := range cases {
		var out bytes.Buffer
		p, u, err := chooseProvider(context.Background(), bufio.NewReader(strings.NewReader(c.input)), &out)
		if err != nil || p != c.provider || u != c.server {
			t.Errorf("input %q: got %q %q %v, want %q %q", c.input, p, u, err, c.provider, c.server)
		}
	}
	var out bytes.Buffer
	chooseProvider(context.Background(), bufio.NewReader(strings.NewReader("9\n1\n")), &out)
	if !strings.Contains(out.String(), "Please answer a number from 1 to 4.") {
		t.Errorf("no hint after a bad answer:\n%s", out.String())
	}
}

// Ctrl+C (a cancelled context) must end a prompt even while nothing is typed.
func TestPromptsStopOnCancel(t *testing.T) {
	r, w := io.Pipe()
	defer w.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, _, err := chooseProvider(ctx, bufio.NewReader(r), io.Discard)
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("prompt ignored the cancellation")
	}
}
