package lockfile

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestLockExcludes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "x.lock")
	unlock, err := Lock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	got := false
	done := make(chan struct{})
	go func() {
		u, err := Lock(context.Background(), path)
		if err != nil {
			t.Error(err)
		}
		mu.Lock()
		got = true
		mu.Unlock()
		u()
		close(done)
	}()
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	if got {
		t.Fatal("a second Lock succeeded while the first was held")
	}
	mu.Unlock()
	unlock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the second Lock never got the lock")
	}
}

func TestLockGivesUpWhenContextEnds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.lock")
	unlock, err := Lock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := Lock(ctx, path); err == nil {
		t.Fatal("Lock succeeded while the lock was held")
	}
}
