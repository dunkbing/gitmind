package gitsync

import (
	"context"
	"os"
	"strings"
	"testing"
)

func TestSSHEnv(t *testing.T) {
	ctx := context.Background()
	for _, k := range []string{"GIT_SSH_COMMAND", "GIT_SSH"} {
		old, had := os.LookupEnv(k)
		os.Unsetenv(k)
		if had {
			t.Cleanup(func() { os.Setenv(k, old) })
		}
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	r := &Repo{Dir: t.TempDir()}
	if _, err := r.run(ctx, "init", "-q"); err != nil {
		t.Fatal(err)
	}
	if got := r.sshEnv(ctx, []string{"fetch", "-q", "origin"}); len(got) != 1 || !strings.Contains(got[0], "ServerAliveInterval") {
		t.Errorf("network command: %v", got)
	}
	if got := r.sshEnv(ctx, []string{"-c", "user.name=x", "push", "origin"}); len(got) != 1 {
		t.Errorf("push after -c options: %v", got)
	}
	if got := r.sshEnv(ctx, []string{"status"}); got != nil {
		t.Errorf("local command: %v", got)
	}
	if _, err := r.run(ctx, "config", "core.sshCommand", "ssh -i mykey"); err != nil {
		t.Fatal(err)
	}
	if got := r.sshEnv(ctx, []string{"fetch"}); got != nil {
		t.Errorf("user's own core.sshCommand was overridden: %v", got)
	}
}
