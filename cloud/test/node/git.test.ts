import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, Session } from "../../src/repo/git";
import { startGitServer, type GitServer } from "./git-server";

// Async on purpose: the git server runs in this process, so a blocking call
// to git would deadlock it.
const run = async (cmd: string, args: string[]) => (await promisify(execFile)(cmd, args)).stdout.toString();

let server: GitServer;
beforeAll(async () => {
	server = await startGitServer();
});
afterAll(() => server.close());

const remote = (repo: string) => ({ url: server.url(repo), auth: async () => ({ username: "x", password: "token" }) });
const author = { name: "gitmind cloud", email: "cloud@gitmind" };

describe("Session", () => {
	it("starts from an empty repo, commits, and reads back", async () => {
		server.createRepo("empty");
		const s = await Session.open(remote("empty"));
		expect(s.head).toBeNull();
		const oid = await s.commit([{ path: "general/prefs.md", content: "# Prefs\n- pnpm\n" }, { path: ".gitattributes", content: "*.md merge=union\n" }], "first", author);
		expect(oid).toMatch(/^[0-9a-f]{40}$/);

		const again = await Session.open(remote("empty"));
		expect(again.head).toBe(oid);
		expect(await again.read("general/prefs.md")).toBe("# Prefs\n- pnpm\n");
		expect([...again.blobs.keys()].sort()).toEqual([".gitattributes", "general/prefs.md"]);
		expect(await Session.remoteHead(remote("empty"))).toBe(oid);

		// Edits and deletes on top, then a real git client sees the result.
		await again.commit([{ path: "general/prefs.md", content: "# Prefs\n- bun\n" }, { path: "a/b/c.md", content: "deep" }], "second", author);
		await again.commit([{ path: "a/b/c.md", content: null }], "delete", author);
		const clone = mkdtempSync(join(tmpdir(), "clone-"));
		await run("git", ["clone", "-q", server.url("empty"), clone]);
		expect(readFileSync(join(clone, "general/prefs.md"), "utf8")).toBe("# Prefs\n- bun\n");
		expect((await run("git", ["-C", clone, "log", "--format=%s"])).trim().split("\n")).toEqual(["delete", "second", "first"]);
		expect((await run("git", ["-C", clone, "ls-files"])).trim().split("\n").sort()).toEqual([".gitattributes", "general/prefs.md"]);
	});

	it("reports a conflict when someone else pushed first", async () => {
		server.createRepo("race");
		const seed = await Session.open(remote("race"));
		await seed.commit([{ path: "a.md", content: "a" }], "seed", author);

		const first = await Session.open(remote("race"));
		const second = await Session.open(remote("race"));
		await first.commit([{ path: "a.md", content: "from first" }], "first", author);
		await expect(second.commit([{ path: "b.md", content: "from second" }], "second", author)).rejects.toBeInstanceOf(ConflictError);

		// A fresh session commits on top of the winner.
		const retry = await Session.open(remote("race"));
		await retry.commit([{ path: "b.md", content: "from second" }], "second", author);
		const check = await Session.open(remote("race"));
		expect(await check.read("a.md")).toBe("from first");
		expect(await check.read("b.md")).toBe("from second");
	});

	it("sees pushes made with plain git", async () => {
		server.createRepo("cli");
		const work = mkdtempSync(join(tmpdir(), "work-"));
		await run("git", ["clone", "-q", server.url("cli"), work]);
		await run("sh", ["-c", `cd ${work} && mkdir -p notes && echo hi > notes/x.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm cli && git push -q origin HEAD:main`]);
		const s = await Session.open(remote("cli"));
		expect(await s.read("notes/x.md")).toBe("hi\n");
	});
});
