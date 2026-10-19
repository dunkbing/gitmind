package server

import (
	"context"
	"errors"
	"io"
	"log"
	"path/filepath"
	"testing"
	"time"

	"github.com/dunkbing/gitmind/internal/gitsync"
	"github.com/dunkbing/gitmind/internal/index"
	"github.com/dunkbing/gitmind/internal/memory"
)

func testApp(t *testing.T) *memory.App {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "notes")
	if err := gitsync.Init(context.Background(), dir, "", "user.name=test", "user.email=test@test"); err != nil {
		t.Fatal(err)
	}
	app, err := memory.Open(dir, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	return app
}

func paths(hits []index.Hit) []string {
	out := make([]string, len(hits))
	for i, h := range hits {
		out[i] = h.Path
	}
	return out
}

func TestSearchMergesRemoteMeaning(t *testing.T) {
	app := testApp(t)
	ctx := context.Background()
	for _, n := range [][2]string{{"Shipping releases", "- [setup] we deploy with the release script"}, {"Lunch", "- pho on tuesdays"}} {
		if _, _, err := app.Write(ctx, n[0], "ops", n[1], nil, false); err != nil {
			t.Fatal(err)
		}
	}
	in := SearchArgs{Query: "putting code into production"}
	q, _ := toQuery(in, time.Now())

	// The server finds the deploy note by meaning, plus a note this machine
	// has deleted (not pushed yet), which is left out.
	remote := func(ctx context.Context, in SearchArgs) ([]index.Hit, error) {
		return []index.Hit{{Path: "ops/shipping-releases.md", Title: "Shipping releases"}, {Path: "ops/gone.md", Title: "Gone"}}, nil
	}
	hits, err := search(ctx, app, remote, in, q)
	if err != nil {
		t.Fatal(err)
	}
	if got := paths(hits); len(got) != 1 || got[0] != "ops/shipping-releases.md" {
		t.Errorf("hybrid = %v", got)
	}

	// Keyword mode, and a server that fails, use the local index alone.
	in.Mode = "keyword"
	if hits, _ := search(ctx, app, remote, in, q); len(hits) != 0 {
		t.Errorf("keyword mode found %v", paths(hits))
	}
	in.Mode = ""
	failing := func(context.Context, SearchArgs) ([]index.Hit, error) { return nil, errors.New("offline") }
	in.Query = "deploy"
	q, _ = toQuery(in, time.Now())
	if hits, err := search(ctx, app, failing, in, q); err != nil || len(hits) != 1 {
		t.Errorf("fallback = %v, %v", paths(hits), err)
	}
}
