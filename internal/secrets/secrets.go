// Package secrets catches credentials before they are committed to the notes
// repository, where git history would keep them forever.
package secrets

import "regexp"

var patterns = []struct {
	kind string
	re   *regexp.Regexp
}{
	{"private key", regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`)},
	{"Anthropic API key", regexp.MustCompile(`sk-ant-[A-Za-z0-9_-]{20,}`)},
	{"OpenAI-style API key", regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{20,}`)},
	{"GitHub token", regexp.MustCompile(`\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})`)},
	{"AWS access key", regexp.MustCompile(`\b(AKIA|ASIA)[0-9A-Z]{16}\b`)},
	{"Google API key", regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}`)},
	{"Slack token", regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`)},
	{"assigned secret", regexp.MustCompile(`(?i)\b(api[_-]?key|secret|token|passw(or)?d)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}`)},
}

// Find returns the kind of the first credential found in texts, or "".
func Find(texts ...string) string {
	for _, t := range texts {
		for _, p := range patterns {
			if p.re.MatchString(t) {
				return p.kind
			}
		}
	}
	return ""
}
