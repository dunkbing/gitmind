// The TypeScript engine must behave exactly like the Go one (internal/notes),
// since the CLI and the cloud write the same files. These mirror the Go tests.
import { describe, expect, it } from "vitest";
import {
	cleanDir, format, inlineTags, links, linkTarget, observations, parse, replaceSection, rewriteLinks, slugify, validPath,
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

describe("import", () => {
	it("rejects files with nothing to import", () => {
		expect(() => parseExport("x.json", new TextEncoder().encode("{}"))).toThrow("not a list");
	});
});
