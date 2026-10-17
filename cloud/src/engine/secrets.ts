// Catches credentials before they are committed, where history would keep
// them forever. Ported from internal/secrets/secrets.go.

const patterns: [string, RegExp][] = [
	["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
	["OpenAI-style API key", /\bsk-[A-Za-z0-9_-]{20,}/],
	["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
	["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
	["Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
	["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
	["assigned secret", /\b(api[_-]?key|secret|token|passw(or)?d)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}/i],
];

export function findSecret(...texts: string[]): string {
	for (const t of texts) for (const [kind, re] of patterns) if (re.test(t)) return kind;
	return "";
}

export function checkSecrets(...texts: string[]): void {
	const kind = findSecret(...texts);
	if (kind) {
		throw new Error(
			`refusing to save: content looks like it contains a ${kind}; remove it and describe where the secret lives instead`,
		);
	}
}
