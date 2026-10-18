// Package lockfile provides an exclusive advisory lock on a file, shared by
// every goroutine and process that locks the same path.
package lockfile

import (
	"os"
	"path/filepath"
)

// Lock blocks until it holds the lock on path, creating the file if needed.
// Locks belong to the open file, so separate Lock calls exclude each other
// even within one process.
func Lock(path string) (unlock func(), err error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		f.Close()
		return nil, err
	}
	return func() {
		unlockFile(f)
		f.Close()
	}, nil
}
