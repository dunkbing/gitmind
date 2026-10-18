package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func tarball(t *testing.T, files map[string]string) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, content := range files {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content)), Typeflag: tar.TypeReg})
		tw.Write([]byte(content))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

// fakeReleases serves a "latest release" with an archive for linux/arm64.
func fakeReleases(t *testing.T, tag string, archive []byte, sums string) *Updater {
	mux := http.NewServeMux()
	var base string
	mux.HandleFunc("/repos/dunkbing/gitmind/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"tag_name": tag,
			"assets": []map[string]string{
				{"name": "gitmind_linux_arm64.tar.gz", "browser_download_url": base + "/dl/archive"},
				{"name": "checksums.txt", "browser_download_url": base + "/dl/sums"},
			},
		})
	})
	mux.HandleFunc("/dl/archive", func(w http.ResponseWriter, r *http.Request) { w.Write(archive) })
	mux.HandleFunc("/dl/sums", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, sums) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	base = srv.URL
	u := New("v0.1.0")
	u.APIURL, u.OS, u.Arch = srv.URL, "linux", "arm64"
	return u
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestUpdate(t *testing.T) {
	archive := tarball(t, map[string]string{"README.md": "docs", "gitmind": "#!/bin/sh\necho new\n"})
	u := fakeReleases(t, "v0.2.0", archive, sha(archive)+"  gitmind_linux_arm64.tar.gz\n"+strings.Repeat("0", 64)+"  gitmind_darwin_arm64.tar.gz\n")
	ctx := context.Background()

	r, newer, err := u.Latest(ctx)
	if err != nil || !newer || r.Tag != "v0.2.0" {
		t.Fatalf("Latest = %+v, %v, %v", r, newer, err)
	}
	exe := filepath.Join(t.TempDir(), "gitmind")
	os.WriteFile(exe, []byte("old"), 0o755)
	if err := u.Apply(ctx, r, exe); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(exe); string(data) != "#!/bin/sh\necho new\n" {
		t.Errorf("binary = %q", data)
	}
	if info, _ := os.Stat(exe); runtime.GOOS != "windows" && info.Mode().Perm() != 0o755 {
		t.Errorf("mode = %v", info.Mode())
	}
	if leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(exe), ".gitmind-update-*")); len(leftovers) != 0 {
		t.Errorf("temp files left behind: %v", leftovers)
	}

	u.Current = "v0.2.0"
	if _, newer, _ := u.Latest(ctx); newer {
		t.Error("the same version reported as newer")
	}
}

func TestUpdateRefusesBadDownloads(t *testing.T) {
	archive := tarball(t, map[string]string{"gitmind": "new"})
	ctx := context.Background()
	exe := filepath.Join(t.TempDir(), "gitmind")
	os.WriteFile(exe, []byte("old"), 0o755)

	u := fakeReleases(t, "v0.2.0", archive, strings.Repeat("a", 64)+"  gitmind_linux_arm64.tar.gz\n")
	r, _, _ := u.Latest(ctx)
	if err := u.Apply(ctx, r, exe); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Errorf("tampered download: %v", err)
	}

	u = fakeReleases(t, "v0.2.0", archive, sha(archive)+"  gitmind_linux_arm64.tar.gz\n")
	u.Arch = "riscv64"
	r, _, _ = u.Latest(ctx)
	if err := u.Apply(ctx, r, exe); err == nil || !strings.Contains(err.Error(), "no build for linux/riscv64") {
		t.Errorf("missing build: %v", err)
	}
	if data, _ := os.ReadFile(exe); string(data) != "old" {
		t.Error("a refused update changed the binary")
	}
}

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"v0.2.0", "v0.1.9", true},
		{"v0.10.0", "v0.9.0", true},
		{"v1.0.0", "v0.99.99", true},
		{"v0.2.0", "v0.2.0", false},
		{"v0.1.0", "v0.2.0", false},
		{"v0.1.0", "0.1.0-dev", true},
		{"nightly", "v0.1.0", false},
	} {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func TestWindowsZip(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("gitmind.exe")
	w.Write([]byte("MZ new exe"))
	zw.Close()
	archive := buf.Bytes()

	u := fakeReleases(t, "v0.2.0", archive, sha(archive)+"  gitmind_windows_amd64.zip\n")
	u.OS, u.Arch = "windows", "amd64"
	ctx := context.Background()
	r, _, err := u.Latest(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The fake server names its archive asset for linux/arm64; point it at
	// the Windows name.
	r.Assets[0].Name = "gitmind_windows_amd64.zip"
	exe := filepath.Join(t.TempDir(), "gitmind.exe")
	os.WriteFile(exe, []byte("MZ old exe"), 0o755)
	if err := u.Apply(ctx, r, exe); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(exe); string(data) != "MZ new exe" {
		t.Errorf("binary = %q", data)
	}
	CleanUp(exe)
	if _, err := os.Stat(exe + ".old"); err == nil {
		t.Error("CleanUp left the old binary")
	}
}
