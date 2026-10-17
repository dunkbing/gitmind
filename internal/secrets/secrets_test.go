package secrets

import "testing"

func TestFind(t *testing.T) {
	for _, s := range []string{
		"key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
		"export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx",
		"token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		"AKIAABCDEFGHIJKLMNOP",
		"-----BEGIN OPENSSH PRIVATE KEY-----",
		`password: "hunter2hunter2hunter2"`,
	} {
		if Find(s) == "" {
			t.Errorf("missed secret in %q", s)
		}
	}
	for _, s := range []string{
		"The API key lives in 1Password under 'Stripe prod'.",
		"Use sk- prefixed keys for OpenAI.",
		"token refresh happens every 15 minutes",
		"- [decision] use pnpm over npm #tooling",
	} {
		if kind := Find(s); kind != "" {
			t.Errorf("false positive %s in %q", kind, s)
		}
	}
}
