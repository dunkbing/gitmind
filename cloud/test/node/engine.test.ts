// The TypeScript engine must behave exactly like the Go one (internal/notes),
// since the CLI and the cloud write the same files. These mirror the Go tests.
import { describe, expect, it } from "vitest";
import {
	cleanDir, currentObservations, factOverlap, factWords, format, inlineTags, links, linkTarget, observations, parse, replaceSection,
	rewriteLinks, slugify, splitHistory, supersede, validPath,
} from "../../src/engine/notes";
import { findSecret } from "../../src/engine/secrets";
import { parseExport } from "../../src/import";

describe("notes", () => {
	it("round-trips the frontmatter the Go CLI writes", () => {
		const n = {
			path: "myapp/deploy.md", title: "Deploy: steps & gotchas", tags: ["ops", "deploy"], created: "2026-10-17T12:00:00Z",
			pinned: true, locked: true, extra: ["type: note", "aliases:", "  - shipping"], body: "- [gotcha] run migrations first #db\n",
		};
		const text = format(n);
		// Byte-for-byte what notes.Note.Format produces in Go.
		expect(text).toBe('---\ntitle: "Deploy: steps & gotchas"\ntags: [ops, deploy]\ncreated: 2026-10-17T12:00:00Z\npinned: true\nlocked: true\ntype: note\naliases:\n  - shipping\n---\n\n- [gotcha] run migrations first #db\n');
		expect(parse(n.path, text)).toEqual(n);
	});

	it("reads Basic Memory notes", () => {
		const n = parse("setup/x.md", "---\ntitle: Memory server setup\ntype: note\npermalink: setup/x\ntags:\n- infra\n- '#VPS'\n---\n\nBody here.\n");
		expect(n.title).toBe("Memory server setup");
		expect(n.tags).toEqual(["infra", "vps"]);
		expect(n.extra).toEqual(["type: note", "permalink: setup/x"]);
		expect(n.body).toBe("Body here.\n");
	});

	it("slugifies like Go", () => {
		const cases: Record<string, string> = {
			"Deploy: steps & gotchas": "deploy-steps-gotchas",
			"  Hello   World  ": "hello-world",
			"Tiếng Việt": "tieng-viet",
			"Đà Nẵng đường phố": "da-nang-duong-pho",
			"Straße & Øl": "strasse-ol",
			"Café (decomposed)": "cafe-decomposed",
			"東京 notes": "東京-notes",
			"한국어": "한국어",
			"!!!": "note",
		};
		for (const [input, want] of Object.entries(cases)) expect(slugify(input), input).toBe(want);
		expect(cleanDir("/My App/Ops Notes/")).toBe("my-app/ops-notes");
		expect(() => cleanDir("a/../../etc")).toThrow();
		for (const bad of ["../x.md", ".git/config.md", "/etc/passwd.md", "notes.txt"]) expect(() => validPath(bad), bad).toThrow();
	});

	it("parses links, observations and tags", () => {
		const body = "- depends on [[Auth Service]]\n- [decision] use JWT, see [[Token format#Claims|claims]] and [[ops/Runbook]]\nProse mentioning [[Auth Service]] again.\n```\n[[Not a link]]\n```\n- this line explains a lot of things before [[Glossary]]\n";
		expect(links(body)).toEqual([
			{ target: "Auth Service", relation: "depends on" },
			{ target: "Token format", relation: "" },
			{ target: "ops/Runbook", relation: "" },
			{ target: "Auth Service", relation: "" },
			{ target: "Glossary", relation: "" },
		]);
		expect(linkTarget("ops/Runbook.md")).toEqual({ notePath: "ops/runbook.md", slug: "runbook" });
		const obsBody = "# Heading\n- [Decision] use JWT #auth #Security\n- [ ] a todo\n- [x] done #chore\n* [gotcha] tokens expire (see [[Auth]])\nSee https://x.com/p#frag and #123.\n```\n- [decision] code #notatag\n```\nPlain #prose-tag/.\n";
		expect(observations(obsBody)).toEqual([
			{ category: "decision", text: "use JWT #auth #Security" },
			{ category: "gotcha", text: "tokens expire (see [[Auth]])" },
		]);
		expect(inlineTags(obsBody)).toEqual(["auth", "security", "chore", "prose-tag"]);
	});

	it("rewrites links and replaces sections", () => {
		const r = rewriteLinks("- [[Auth service]] and [[Auth service#T|t]]\n```\n[[Auth service]]\n```", (t) => (t === "Auth service" ? "Identity" : null));
		expect(r).toEqual({ body: "- [[Identity]] and [[Identity#T|t]]\n```\n[[Auth service]]\n```", count: 2 });
		const body = "Intro.\n\n## Setup ##\n\nold\n\n### Details\n\nx\n\n## Usage\n\nkeep\n";
		expect(replaceSection(body, "setup", "new").body).toBe("Intro.\n\n## Setup ##\n\nnew\n\n## Usage\n\nkeep\n");
		expect(replaceSection("Text\n", "Open", "- q").body).toBe("Text\n\n## Open\n\n- q\n");
		expect(() => replaceSection("## A\nx\n## A\ny\n", "A", "z")).toThrow();
	});

	it("finds secrets without false positives", () => {
		expect(findSecret("token ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("GitHub token");
		expect(findSecret("The API key lives in 1Password.")).toBe("");
	});
});

describe("facts that change", () => {
	it("splits off History like Go", () => {
		const body = "- [decision] use Qwen3 #search\n\n## History\n\n- [decision] use bge-m3 (replaced 2026-10-18)\n\n### Older\n\n- [decision] use FTS only\n\n## Next\n\n- [task] ship it\n```\n## History\n```\n";
		const { current, history } = splitHistory(body);
		expect(current).not.toContain("bge-m3");
		expect(current).not.toContain("FTS only");
		expect(current).toContain("ship it");
		expect(current).toContain("```\n## History\n```");
		expect(history).toContain("bge-m3");
		expect(history).toContain("FTS only");
		expect(currentObservations(body).map((o) => o.text)).toEqual(["use Qwen3 #search", "ship it"]);
	});

	it("supersedes facts like Go", () => {
		let body = "Intro.\n\n- [decision] Use  bge-m3 embeddings #search\n  - [gotcha] slow on ARM\n- [setup] runs nightly\n";
		body = supersede(body, "use bge-m3 embeddings", "[decision] use Qwen3 embeddings #search", "2026-10-19");
		expect(body).toBe("Intro.\n\n- [decision] use Qwen3 embeddings #search\n  - [gotcha] slow on ARM\n- [setup] runs nightly\n\n## History\n\n- [decision] Use  bge-m3 embeddings #search (replaced 2026-10-19)\n");
		body = supersede(body, "- [gotcha] slow on ARM", "fast since Go 1.25", "2026-10-20");
		expect(body).toContain("\n  - fast since Go 1.25\n");
		expect(body.endsWith("## History\n\n- [gotcha] slow on ARM (replaced 2026-10-20)\n- [decision] Use  bge-m3 embeddings #search (replaced 2026-10-19)\n")).toBe(true);
		expect(() => supersede(body, "use bge-m3 embeddings", "x", "2026-10-21")).toThrow(/current facts/);
		body = supersede(body, "[setup] runs nightly", "", "2026-10-21");
		expect(body.split("## History")[0]).not.toContain("nightly");
		expect(body).toContain("- [setup] runs nightly (removed 2026-10-21)");
		const twice = "- [task] deploy\n- [task] deploy #ops\n";
		expect(() => supersede(twice, "deploy", "done", "2026-10-19")).toThrow(/2 current facts/);
		expect(() => supersede(twice, "[decision] deploy", "done", "2026-10-19")).toThrow();
	});

	it("finds facts about the same thing like Go", () => {
		const cases: [string, string, boolean][] = [
			["[decision] use bge-m3 embeddings for search", "[decision] use Qwen3 embeddings, which ranked notes better than bge-m3", true],
			["deploys go through Cloudflare builds", "Cloudflare builds deploy on every push", true],
			["prefers tabs", "prefers tabs #style", true],
			["use bun, not npm", "deploy with wrangler", false],
			["the search index lives in SQLite", "the session context has a size budget", false],
		];
		for (const [a, b, conflict] of cases) expect([a, b, factOverlap(factWords(a), factWords(b)) >= 0.5]).toEqual([a, b, conflict]);
	});
});

describe("import", () => {
	it("rejects files with nothing to import", () => {
		expect(() => parseExport("x.json", new TextEncoder().encode("{}"))).toThrow("not a list");
	});
});
