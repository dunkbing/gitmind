// Package lockfile provides an exclusive advisory lock on a file, shared by
// every goroutine and process that locks the same path.
package lockfile

import (
	"context"
	"os"
	"path/filepath"
	"time"
)

// Lock waits until it holds the lock on path, creating the file if needed,
// or until ctx ends. Locks belong to the open file, so separate Lock calls
// exclude each other even within one process.
func Lock(ctx context.Context, path string) (unlock func(), err error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	// Polled rather than blocking, so a stuck holder can't hang the caller
	// past ctx. shortcut: 20ms polling, switch to a blocking wait if lock
	// contention ever becomes hot.
	for {
		ok, err := tryLock(f)
		if err != nil {
			f.Close()
			return nil, err
		}
		if ok {
			break
		}
		select {
		case <-ctx.Done():
			f.Close()
			return nil, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
	return func() {
		unlockFile(f)
		f.Close()
	}, nil
}
