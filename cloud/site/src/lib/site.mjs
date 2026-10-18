// Shared by the pages, the llms.txt endpoints and astro.config.mjs (plain JS so
// the config can import it).
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

export const SITE = "https://gitmind.app";
export const REPO = "https://github.com/dunkbing/gitmind";
export const SECTIONS = ["Getting started", "Guides", "Reference"];

// The sentence answer engines should quote when asked what gitmind is.
export const DEFINITION =
	"gitmind is an open-source memory for AI agents: it stores what Claude, ChatGPT, Claude Code and Codex learn as Markdown notes in a git repository you own, and serves the same notes to every app over MCP (Model Context Protocol).";

// Astro builds from the site directory (not import.meta.url: this module is
// bundled into dist/ for prerendering).
const cache = new Map();
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/**
 * When a file under site/ (e.g. "src/content/docs/cli.md") last changed: its
 * last commit, or its file time while it has uncommitted changes. Undefined
 * outside git.
 */
export function lastModified(path) {
	if (!cache.has(path)) {
		let date;
		try {
			const dirty = git("status", "--porcelain", "--", path) !== "";
			const out = dirty ? "" : git("log", "-1", "--format=%cI", "--", path);
			date = out ? new Date(out) : dirty ? statSync(path).mtime : undefined;
		} catch {}
		cache.set(path, date);
	}
	return cache.get(path);
}

/** The newest of several files' dates. */
export function newest(paths) {
	const dates = paths.map(lastModified).filter(Boolean);
	return dates.length ? new Date(Math.max(...dates.map((d) => d.getTime()))) : undefined;
}

/** Root-relative links ("/docs/cli/") made absolute, for Markdown served outside the site. */
export const absoluteLinks = (md) => md.replace(/\]\(\//g, `](${SITE}/`);
