package server

import (
	"testing"
	"time"
)

func TestParseWhen(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	for in, want := range map[string]time.Time{
		"":                     {},
		"2026-10-01":           time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
		"2026-10-01T08:00:00Z": time.Date(2026, 10, 1, 8, 0, 0, 0, time.UTC),
		"7d":                   now.AddDate(0, 0, -7),
		"2w":                   now.AddDate(0, 0, -14),
		"3m":                   now.AddDate(0, -3, 0),
		"1y":                   now.AddDate(-1, 0, 0),
	} {
		if got, err := parseWhen(in, now); err != nil || !got.Equal(want) {
			t.Errorf("parseWhen(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"yesterday", "d", "7x", "-3d"} {
		if _, err := parseWhen(bad, now); err == nil {
			t.Errorf("parseWhen(%q) accepted", bad)
		}
	}
	if _, err := toQuery(SearchArgs{}, now); err == nil {
		t.Error("empty search accepted")
	}
	if q, err := toQuery(SearchArgs{Category: "decision", Since: "7d"}, now); err != nil || q.Limit != 10 {
		t.Errorf("filter-only search: %+v, %v", q, err)
	}
}
