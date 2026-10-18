// Package update replaces the running gitmind binary with the latest GitHub
// release: it finds the release, downloads the archive for this OS and
// architecture, checks it against the release's checksums.txt, and swaps
// the binary in place.
package update

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Repo is where releases come from.
const Repo = "dunkbing/gitmind"

type Updater struct {
	APIURL  string // https://api.github.com, overridable for tests
	Repo    string
	Current string // the running version, e.g. "v0.2.0" or "0.1.0-dev"
	OS      string
	Arch    string
	HTTP    *http.Client
}

func New(current string) *Updater {
	return &Updater{
		APIURL: "https://api.github.com", Repo: Repo, Current: current,
		OS: runtime.GOOS, Arch: runtime.GOARCH, HTTP: &http.Client{Timeout: 2 * time.Minute},
	}
}

type Release struct {
	Tag    string `json:"tag_name"`
	URL    string `json:"html_url"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

// AssetName is the release archive for an OS and architecture, as the
// release workflow names it: a zip on Windows, a tarball elsewhere.
func AssetName(goos, goarch string) string {
	if goos == "windows" {
		return fmt.Sprintf("gitmind_%s_%s.zip", goos, goarch)
	}
	return fmt.Sprintf("gitmind_%s_%s.tar.gz", goos, goarch)
}

// BinaryName is the executable inside the archive.
func BinaryName(goos string) string {
	if goos == "windows" {
		return "gitmind.exe"
	}
	return "gitmind"
}

// Latest returns the newest release, and whether it's newer than Current.
func (u *Updater) Latest(ctx context.Context) (Release, bool, error) {
	var r Release
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/repos/%s/releases/latest", u.APIURL, u.Repo), nil)
	if err != nil {
		return r, false, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := u.HTTP.Do(req)
	if err != nil {
		return r, false, fmt.Errorf("checking for updates: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return r, false, errors.New("no releases published yet")
	}
	if resp.StatusCode != http.StatusOK {
		return r, false, fmt.Errorf("checking for updates: GitHub answered %s", resp.Status)
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return r, false, err
	}
	return r, Newer(r.Tag, u.Current), nil
}

// Apply downloads the release's archive for this machine, verifies its
// checksum, and replaces the binary at exe with the one inside.
func (u *Updater) Apply(ctx context.Context, r Release, exe string) error {
	name := AssetName(u.OS, u.Arch)
	var archiveURL, sumsURL string
	for _, a := range r.Assets {
		switch a.Name {
		case name:
			archiveURL = a.URL
		case "checksums.txt":
			sumsURL = a.URL
		}
	}
	if archiveURL == "" {
		return fmt.Errorf("release %s has no build for %s/%s", r.Tag, u.OS, u.Arch)
	}
	if sumsURL == "" {
		return fmt.Errorf("release %s has no checksums.txt; not installing an unverifiable download", r.Tag)
	}
	sums, err := u.get(ctx, sumsURL)
	if err != nil {
		return err
	}
	want, err := checksumFor(sums, name)
	if err != nil {
		return err
	}
	archive, err := u.get(ctx, archiveURL)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(archive)
	if hex.EncodeToString(sum[:]) != want {
		return fmt.Errorf("the download of %s doesn't match its checksum; not installing it", name)
	}
	binary, err := extract(archive, name, BinaryName(u.OS))
	if err != nil {
		return err
	}
	return replace(exe, binary)
}

// CleanUp removes what a Windows update leaves behind: the previous binary,
// which couldn't be deleted while it was running.
func CleanUp(exe string) {
	os.Remove(exe + ".old")
}

func (u *Updater) get(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := u.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("downloading %s: %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 200<<20))
}

func checksumFor(sums []byte, name string) (string, error) {
	sc := bufio.NewScanner(strings.NewReader(string(sums)))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("checksums.txt has no entry for %s", name)
}

func extract(archive []byte, name, binary string) ([]byte, error) {
	if strings.HasSuffix(name, ".zip") {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if path.Base(f.Name) != binary || f.FileInfo().IsDir() {
				continue
			}
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return io.ReadAll(io.LimitReader(rc, 200<<20))
		}
		return nil, fmt.Errorf("the archive has no %s binary", binary)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("the archive has no %s binary", binary)
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag == tar.TypeReg && filepath.Base(h.Name) == binary {
			return io.ReadAll(io.LimitReader(tr, 200<<20))
		}
	}
}

// replace swaps the file at exe for binary atomically: written next to it,
// then renamed over it. On Unix renaming works even while exe is running,
// since the running process keeps the old file. Windows won't replace a
// running executable, but lets it be renamed, so it's moved aside to
// exe.old first (and removed by CleanUp on a later run).
func replace(exe string, binary []byte) error {
	dir := filepath.Dir(exe)
	tmp, err := os.CreateTemp(dir, ".gitmind-update-*")
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Errorf("no permission to write to %s; run `sudo gitmind update`, or reinstall somewhere you own", dir)
		}
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(binary); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		old := exe + ".old"
		os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			return err
		}
		if err := os.Rename(tmp.Name(), exe); err != nil {
			os.Rename(old, exe) // put the working binary back
			return err
		}
		return nil
	}
	return os.Rename(tmp.Name(), exe)
}

// Newer reports whether release version a is newer than b. Versions are
// "vMAJOR.MINOR.PATCH"; a development build (b not a plain release, e.g.
// "0.1.0-dev") is always older than a release.
func Newer(a, b string) bool {
	av, aok := parse(a)
	bv, bok := parse(b)
	if !aok {
		return false
	}
	if !bok {
		return true
	}
	for i := range av {
		if av[i] != bv[i] {
			return av[i] > bv[i]
		}
	}
	return false
}

func parse(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
