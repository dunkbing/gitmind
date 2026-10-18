import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { Browser, connect, signedIn, tool } from "./helpers";

const html = async (r: Response) => {
	expect(r.status, r.headers.get("Location") ?? "").toBe(200);
	return r.text();
};

describe("web app", () => {
	it("sends signed-out visitors to sign-in and back", async () => {
		const res = await new Browser().fetch("/w/whoever");
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/login?next=%2Fw%2Fwhoever");
	});

	it("creates, views, edits, moves and deletes notes", async () => {
		const erin = await signedIn("erin");
		const home = await erin.fetch("/");
		expect(home.headers.get("Location")).toBe("/w/erin");
		expect(await html(await erin.fetch("/w/erin"))).toContain("No notes yet");

		let res = await erin.post("/w/erin/new", { title: "Deploy steps", directory: "ops", tags: "deploy, ci", content: "- [setup] run [[Migrations]] first\n- see [[Rollback]]" });
		expect(res.headers.get("Location")).toBe("/w/erin/n/ops/deploy-steps.md");
		await erin.post("/w/erin/new", { title: "Rollback", directory: "ops", content: "- [gotcha] keep the last two releases" });

		const page = await html(await erin.fetch("/w/erin/n/ops/deploy-steps.md"));
		expect(page).toContain('<span class="cat">setup</span>');
		expect(page).toContain('<a class="wiki" href="/w/erin/n/ops/rollback.md">Rollback</a>');
		expect(page).toContain('wiki missing" title="No such note yet">Migrations');

		// Search with a category filter shows the matching lines.
		expect(await html(await erin.fetch("/w/erin?category=gotcha"))).toContain("keep the last two releases");

		// Raw edit: lock the note, which keeps agents out but not people.
		const edit = await html(await erin.fetch("/w/erin/edit/ops/rollback.md"));
		const content = /<textarea name="content">([\s\S]*?)<\/textarea>/.exec(edit)![1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
		res = await erin.post("/w/erin/edit/ops/rollback.md", { content: content.replace("---\n\n", "locked: true\n---\n\n") });
		expect(res.headers.get("Location")).toBe("/w/erin/n/ops/rollback.md?flash=Saved");
		const { token } = await connect(erin);
		const agentEdit = await tool(token, "edit_note", { identifier: "Rollback", operation: "append", content: "- nope" });
		expect(agentEdit.isError).toBe(true);
		expect(agentEdit.text).toContain("locked");

		res = await erin.post("/w/erin/move/ops/deploy-steps.md", { directory: "runbooks", title: "Deploy runbook" });
		expect(res.headers.get("Location")).toContain("/w/erin/n/runbooks/deploy-runbook.md");
		res = await erin.post("/w/erin/delete/runbooks/deploy-runbook.md", { confirm: "on" });
		expect(res.headers.get("Location")).toBe("/w/erin");

		const history = await html(await erin.fetch("/w/erin/history"));
		expect(history).toContain("memory: delete runbooks/deploy-runbook.md (cloud, erin)");
		expect(history).toContain("memory: move ops/deploy-steps.md -&#62; runbooks/deploy-runbook.md (cloud, erin)");

		const graph = await (await erin.fetch("/w/erin/graph.json")).json();
		expect(graph).toMatchObject({ nodes: [{ path: "ops/rollback.md", title: "Rollback" }], edges: [] });

		const zip = unzipSync(new Uint8Array(await (await erin.fetch("/w/erin/export.zip")).arrayBuffer()));
		expect(Object.keys(zip)).toEqual(["erin/ops/rollback.md"]);
	});

	it("refuses cross-site form posts", async () => {
		const fay = await signedIn("fay");
		const res = await fay.fetch("/w/fay/new", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" }, body: "title=x&content=y" });
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
		const form = new FormData();
		form.set("file", new File([zipSync({ "conversations.json": strToU8(JSON.stringify(claude)) })], "data.zip"));
		let page = await html(await gus.fetch("/w/gus/import", { method: "POST", body: form }));
		expect(page).toContain("Imported 1 note(s) from claude");

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
		const form2 = new FormData();
		form2.set("file", new File([JSON.stringify(chatgpt)], "conversations.json"));
		page = await html(await gus.fetch("/w/gus/import", { method: "POST", body: form2 }));
		expect(page).toContain("Imported 1 note(s) from chatgpt");

		// Importing again skips what exists.
		const again = new FormData();
		again.set("file", new File([JSON.stringify(chatgpt)], "conversations.json"));
		expect(await html(await gus.fetch("/w/gus/import", { method: "POST", body: again }))).toContain("skipped 1 that already existed");

		const { token } = await connect(gus);
		const found = await tool(token, "search_notes", { query: "work_mem" });
		expect(found.text).toContain("imports/claude/2026-09-01-postgres-tuning.md");
		expect((await tool(token, "search_notes", { query: "citadel" })).text).toContain("imports/chatgpt/");
		expect((await tool(token, "search_notes", { tags: ["import"], limit: 10 })).text.split("\n- ").length).toBe(2);
	});

	it("shares team workspaces through invites", async () => {
		const hana = await signedIn("hana");
		let res = await hana.post("/teams", { name: "Acme Platform" });
		expect(res.headers.get("Location")).toBe("/w/acme-platform/settings");
		const settings = await html(await hana.post("/w/acme-platform/invites", { role: "member" }));
		const link = /(https:\/\/memory\.test\/invite\/[A-Za-z0-9_-]+)/.exec(settings)![1];

		const ivan = await signedIn("ivan");
		expect(await html(await ivan.fetch(link))).toContain("Join Acme Platform?");
		res = await ivan.post(new URL(link).pathname, {});
		expect(res.headers.get("Location")).toBe("/w/acme-platform");
		// Links work once.
		expect(await html(await (await signedIn("jo")).fetch(link))).toContain("invalid or has expired");

		const ivanToken = (await connect(ivan)).token;
		expect((await tool(ivanToken, "list_workspaces")).text).toContain("acme-platform (team, member)");
		await tool(ivanToken, "write_note", { title: "On-call", directory: "ops", content: "- [instruction] page the platform rotation", workspace: "acme-platform" });

		const hanaToken = (await connect(hana)).token;
		expect((await tool(hanaToken, "search_notes", { query: "rotation", workspace: "acme-platform" })).text).toContain("ops/on-call.md");
		expect((await tool(hanaToken, "search_notes", { query: "rotation" })).text).toBe("No notes match.");
		const history = await html(await hana.fetch("/w/acme-platform/history"));
		expect(history).toContain("(cloud, ivan)");

		// Members can't invite; outsiders can't see the team at all.
		expect(await html(await ivan.post("/w/acme-platform/invites", { role: "member" }))).toContain("only owners and admins can invite");
		expect((await (await signedIn("kim")).fetch("/w/acme-platform")).status).toBe(404);
		const kimToken = (await connect(await signedIn("kim"))).token;
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
		expect((await b.fetch("/")).headers.get("Location")).toBe("/w/octo-gh");

		// The poll is bound to the browser that started it.
		const other = new Browser();
		expect(await (await other.fetch("/login/poll", { method: "POST" })).json()).toMatchObject({ error: expect.stringContaining("expired") });
	});
});
