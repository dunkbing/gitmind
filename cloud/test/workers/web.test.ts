import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { Browser, connect, signedIn, tool } from "./helpers";

const html = async (r: Response) => {
	expect(r.status, r.headers.get("Location") ?? "").toBe(200);
	return r.text();
};

// call is the app's JSON API, as the single-page app uses it.
async function call<T = any>(b: Browser, method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
	const init: RequestInit = { method, headers: { "X-Gitmind": "1" } };
	if (body instanceof FormData) init.body = body;
	else if (body !== undefined) {
		init.body = JSON.stringify(body);
		(init.headers as Record<string, string>)["Content-Type"] = "application/json";
	}
	const res = await b.fetch("/api/app" + url, init);
	return { status: res.status, data: (await res.json()) as T };
}

describe("web app", () => {
	it("sends signed-out visitors to sign-in and back", async () => {
		const res = await new Browser().fetch("/w/whoever");
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/login?next=%2Fw%2Fwhoever");
		expect((await new Browser().fetch("/api/app/me")).status).toBe(401);
	});

	it("serves the app shell for every app page", async () => {
		const dee = await signedIn("dee");
		expect((await dee.fetch("/app")).headers.get("Location")).toBe("/w/dee");
		for (const page of ["/w/dee", "/w/dee/n/ops/x.md", "/w/dee/graph", "/connect"]) {
			const res = await dee.fetch(page);
			expect(await html(res)).toContain('<div id="root">');
			expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
		}
	});

	it("creates, reads, edits, moves and deletes notes", async () => {
		const erin = await signedIn("erin");
		const me = await call(erin, "GET", "/me");
		expect(me.data.user.login).toBe("erin");
		expect(me.data.workspaces.map((w: { slug: string }) => w.slug)).toEqual(["erin"]);
		expect((await call(erin, "GET", "/w/erin/notes")).data).toEqual([]);

		let r = await call(erin, "POST", "/w/erin/notes", { title: "Deploy steps", directory: "ops", tags: ["deploy", "ci"], content: "- [setup] run [[Migrations]] first\n- see [[Rollback]]" });
		expect(r.data.path).toBe("ops/deploy-steps.md");
		await call(erin, "POST", "/w/erin/notes", { title: "Rollback", directory: "ops", content: "- [gotcha] keep the last two releases" });
		const list = (await call(erin, "GET", "/w/erin/notes")).data;
		expect(list.map((n: { path: string }) => n.path).sort()).toEqual(["ops/deploy-steps.md", "ops/rollback.md"]);

		await call(erin, "POST", "/w/erin/pin", { path: "ops/rollback.md", pinned: true });
		expect((await call(erin, "GET", "/w/erin/notes")).data.find((n: { path: string }) => n.path === "ops/rollback.md").pinned).toBe(true);
		const note = (await call(erin, "GET", "/w/erin/note?path=ops/rollback.md")).data;
		expect(note.content).toContain("keep the last two releases");
		expect(note.backlinks).toEqual([{ title: "Deploy steps", path: "ops/deploy-steps.md" }]);

		// Search with a category filter shows the matching lines.
		const hits = (await call(erin, "GET", "/w/erin/search?category=gotcha")).data;
		expect(hits[0].observations).toEqual(["keep the last two releases"]);

		// Saving checks the version it started from: a stale save is refused
		// with the current content, so nothing is overwritten unseen.
		const locked = note.content.replace("---\n\n", "locked: true\n---\n\n");
		r = await call(erin, "PUT", "/w/erin/note", { path: "ops/rollback.md", content: locked, base: note.hash });
		expect(r.status).toBe(200);
		const stale = await call(erin, "PUT", "/w/erin/note", { path: "ops/rollback.md", content: "overwrite", base: note.hash });
		expect(stale.status).toBe(409);
		expect(stale.data.current.content).toBe(locked);

		// Locked keeps agents out but not people.
		const { token } = await connect(erin);
		const agentEdit = await tool(token, "edit_note", { identifier: "Rollback", operation: "append", content: "- nope" });
		expect(agentEdit.isError).toBe(true);
		expect(agentEdit.text).toContain("locked");

		r = await call(erin, "POST", "/w/erin/move", { path: "ops/deploy-steps.md", directory: "runbooks", title: "Deploy runbook" });
		expect(r.data.path).toBe("runbooks/deploy-runbook.md");
		r = await call(erin, "DELETE", "/w/erin/note?path=runbooks/deploy-runbook.md");
		expect(r.status).toBe(200);

		const history = (await call(erin, "GET", "/w/erin/history")).data.map((c: { message: string }) => c.message);
		expect(history).toContain("memory: delete runbooks/deploy-runbook.md (cloud, erin)");
		expect(history).toContain("memory: move ops/deploy-steps.md -> runbooks/deploy-runbook.md (cloud, erin)");

		const graph = (await call(erin, "GET", "/w/erin/graph")).data;
		expect(graph).toMatchObject({ nodes: [{ path: "ops/rollback.md", title: "Rollback" }], edges: [] });

		const zip = unzipSync(new Uint8Array(await (await erin.fetch("/w/erin/export.zip")).arrayBuffer()));
		expect(Object.keys(zip)).toEqual(["erin/ops/rollback.md"]);
	});

	it("refuses changes without the app's header or from other sites", async () => {
		const fay = await signedIn("fay");
		const body = JSON.stringify({ title: "x", content: "y" });
		let res = await fay.fetch("/api/app/w/fay/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body });
		expect(res.status).toBe(403);
		res = await fay.fetch("/api/app/w/fay/notes", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", "X-Gitmind": "1" }, body });
		expect(res.status).toBe(403);
	});

	it("imports Claude and ChatGPT exports", async () => {
		const gus = await signedIn("gus");
		const claude = [
			{
				name: "Postgres tuning",
				created_at: "2026-09-01T10:00:00Z",
				chat_messages: [
					{ sender: "human", text: "How should I set work_mem?" },
					{ sender: "assistant", content: [{ type: "text", text: "Start with 64MB for analytics queries." }] },
				],
			},
			{ name: "Empty", created_at: "2026-09-02T10:00:00Z", chat_messages: [] },
		];
		const upload = (file: File) => {
			const form = new FormData();
			form.set("file", file);
			return call(gus, "POST", "/w/gus/import", form);
		};
		let r = await upload(new File([zipSync({ "conversations.json": strToU8(JSON.stringify(claude)) })], "data.zip"));
		expect(r.data).toMatchObject({ source: "claude", written: ["imports/claude/2026-09-01-postgres-tuning.md"] });

		const chatgpt = [
			{
				title: "Trip plan",
				create_time: 1790000000,
				current_node: "c",
				mapping: {
					a: { parent: null, message: null },
					b: { parent: "a", message: { author: { role: "user" }, content: { content_type: "text", parts: ["Plan a trip to Hue"] } } },
					c: { parent: "b", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["Day 1: the citadel."] } } },
				},
			},
		];
		r = await upload(new File([JSON.stringify(chatgpt)], "conversations.json"));
		expect(r.data.source).toBe("chatgpt");
		expect(r.data.written.length).toBe(1);

		// Importing again skips what exists.
		r = await upload(new File([JSON.stringify(chatgpt)], "conversations.json"));
		expect(r.data.skipped.length).toBe(1);

		const { token } = await connect(gus);
		const found = await tool(token, "search_notes", { query: "work_mem" });
		expect(found.text).toContain("imports/claude/2026-09-01-postgres-tuning.md");
		expect((await tool(token, "search_notes", { query: "citadel" })).text).toContain("imports/chatgpt/");
		expect((await tool(token, "search_notes", { tags: ["import"], limit: 10 })).text.split("\n- ").length).toBe(2);
	});

	it("shares team workspaces through invites", async () => {
		const hana = await signedIn("hana");
		const team = await call(hana, "POST", "/teams", { name: "Acme Platform" });
		expect(team.data.slug).toBe("acme-platform");
		const link = (await call(hana, "POST", "/w/acme-platform/invites", { role: "member" })).data.url as string;
		expect(link).toMatch(/^https:\/\/memory\.test\/invite\/[A-Za-z0-9_-]+$/);

		const ivan = await signedIn("ivan");
		expect(await html(await ivan.fetch(link))).toContain("Join Acme Platform?");
		const res = await ivan.post(new URL(link).pathname, {});
		expect(res.headers.get("Location")).toBe("/w/acme-platform");
		// Links work once.
		expect(await html(await (await signedIn("jo")).fetch(link))).toContain("invalid or has expired");

		const ivanToken = (await connect(ivan)).token;
		expect((await tool(ivanToken, "list_workspaces")).text).toContain("acme-platform (team, member)");
		await tool(ivanToken, "write_note", { title: "On-call", directory: "ops", content: "- [instruction] page the platform rotation", workspace: "acme-platform" });

		const hanaToken = (await connect(hana)).token;
		expect((await tool(hanaToken, "search_notes", { query: "rotation", workspace: "acme-platform" })).text).toContain("ops/on-call.md");
		expect((await tool(hanaToken, "search_notes", { query: "rotation" })).text).toBe("No notes match.");
		const history = (await call(hana, "GET", "/w/acme-platform/history")).data;
		expect(history.some((c: { message: string }) => c.message.includes("(cloud, ivan)"))).toBe(true);
		const settings = (await call(hana, "GET", "/w/acme-platform/settings")).data;
		expect(settings.members.map((m: { login: string }) => m.login)).toEqual(["hana", "ivan"]);

		// Members can't invite; outsiders can't see the team at all.
		const denied = await call(ivan, "POST", "/w/acme-platform/invites", { role: "member" });
		expect(denied.status).toBe(400);
		expect(denied.data.error).toContain("only owners and admins can invite");
		const kim = await signedIn("kim");
		expect((await call(kim, "GET", "/w/acme-platform/notes")).status).toBe(404);
		const kimToken = (await connect(kim)).token;
		expect((await tool(kimToken, "search_notes", { query: "rotation", workspace: "acme-platform" })).isError).toBe(true);
	});
});

describe("GitHub sign-in without a client secret", () => {
	it("uses the device flow: shows a code, polls, then signs in", async () => {
		const b = new Browser();
		const start = await b.fetch("/login?next=%2Fconnect");
		const html = await start.text();
		expect(start.status).toBe(200);
		expect(html).toContain("ABCD-1234");
		expect(html).toContain("https://github.com/login/device");

		expect(await (await b.fetch("/login/poll", { method: "POST" })).json()).toEqual({ pending: true });
		expect(await (await b.fetch("/login/poll", { method: "POST" })).json()).toEqual({ done: true, next: "/connect" });
		// Signed in, with a personal workspace named after the GitHub login.
		expect((await b.fetch("/app")).headers.get("Location")).toBe("/w/octo-gh");

		// The poll is bound to the browser that started it.
		const other = new Browser();
		expect(await (await other.fetch("/login/poll", { method: "POST" })).json()).toMatchObject({ error: expect.stringContaining("expired") });
	});
});
