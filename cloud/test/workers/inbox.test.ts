import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Session } from "../../src/repo/git";
import { BASE, type Browser, connect, signedIn, tool } from "./helpers";

async function call<T = any>(b: Browser, method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
	const res = await b.fetch("/api/app" + url, {
		method,
		headers: { "X-Gitmind": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, data: (await res.json()) as T };
}

const inbox = async (b: Browser, slug: string) => (await call(b, "GET", `/w/${slug}/inbox`)).data;

describe("inbox", () => {
	it("collects what AI apps change, with where it came from, for review", async () => {
		const bo = await signedIn("bo");
		const { token } = await connect(bo, { clientName: "claude.ai" });

		// The user's own notes don't need review.
		await call(bo, "POST", "/w/bo/notes", { title: "Stack", directory: "dev", content: "- [decision] Use Postgres" });
		expect((await inbox(bo, "bo")).items).toEqual([]);

		await tool(token, "write_note", { title: "Lunch", directory: "life", content: "- pho on tuesdays" });
		await tool(token, "edit_note", { identifier: "Stack", operation: "append", content: "- [decision] Use Redis for queues" });
		await tool(token, "edit_note", { identifier: "Stack", operation: "append", content: "- [gotcha] Redis needs persistence on" });
		let box = await inbox(bo, "bo");
		expect(box.items.map((i: { path: string }) => i.path).sort()).toEqual(["dev/stack.md", "life/lunch.md"]);
		const stack = box.items.find((i: { path: string }) => i.path === "dev/stack.md");
		// Two edits to one note make one review, from before the first to after the last.
		expect(stack.before).not.toContain("Redis");
		expect(stack.after).toContain("Redis needs persistence");
		expect(stack.source).toBe("claude.ai");
		expect(box.items.find((i: { path: string }) => i.path === "life/lunch.md").before).toBeNull();
		expect((await call(bo, "GET", "/w/bo/inbox/count")).data.count).toBe(2);
		// The commit says which app made it.
		const history = (await call(bo, "GET", "/w/bo/history")).data.map((c: { message: string }) => c.message);
		expect(history).toContain("memory: edit dev/stack.md (cloud, bo, claude.ai)");

		// Rejecting undoes the change; a reason teaches agents through a pinned note.
		let r = await call(bo, "POST", `/w/bo/inbox/${stack.id}/reject`, { reason: "infrastructure guesses" });
		expect(r.status).toBe(200);
		expect((await call(bo, "GET", "/w/bo/note?path=dev/stack.md")).data.content).not.toContain("Redis");
		const feedback = (await call(bo, "GET", "/w/bo/note?path=general/memory-feedback.md")).data.content;
		expect(feedback).toContain("pinned: true");
		expect(feedback).toContain("- [instruction] Don't save: infrastructure guesses");
		expect((await tool(token, "project_context", {})).text).toContain("infrastructure guesses");

		// Rejecting a note the agent created removes it; accepting keeps it.
		await tool(token, "write_note", { title: "Noise", directory: "life", content: "- the user said hi" });
		box = await inbox(bo, "bo");
		const noise = box.items.find((i: { path: string }) => i.path === "life/noise.md");
		await call(bo, "POST", `/w/bo/inbox/${noise.id}/reject`, {});
		expect((await call(bo, "GET", "/w/bo/note?path=life/noise.md")).status).toBe(404);
		const lunch = box.items.find((i: { path: string }) => i.path === "life/lunch.md");
		await call(bo, "POST", "/w/bo/inbox/accept", { ids: [lunch.id] });
		expect((await inbox(bo, "bo")).items).toEqual([]);
		expect((await call(bo, "GET", "/w/bo/note?path=life/lunch.md")).status).toBe(200);

		// Editing a note yourself counts as reviewing the agent's change to it.
		await tool(token, "edit_note", { identifier: "Lunch", operation: "append", content: "- bun cha on fridays" });
		const note = (await call(bo, "GET", "/w/bo/note?path=life/lunch.md")).data;
		await call(bo, "PUT", "/w/bo/note", { path: "life/lunch.md", content: note.content + "- and coffee\n", base: note.hash });
		expect((await inbox(bo, "bo")).items).toEqual([]);

		// Trusted apps skip the inbox.
		r = await call(bo, "PUT", "/w/bo/review", { enabled: true, trusted: ["claude.ai"] });
		expect(r.data).toEqual({ enabled: true, trusted: ["claude.ai"] });
		await tool(token, "write_note", { title: "Trusted", directory: "life", content: "- fine" });
		box = await inbox(bo, "bo");
		expect(box.items).toEqual([]);
		expect(box.sources).toContain("claude.ai");
	});

	it("includes agents' changes pushed from a laptop", async () => {
		const cy = await signedIn("cy");
		const { token } = await connect(cy, { clientName: "gitmind CLI" });
		await call(cy, "POST", "/w/cy/notes", { title: "Seed", directory: "", content: "- x" });
		const creds = (await (await SELF.fetch(`${BASE}/mcp/api/workspaces/cy/git-credentials`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).json()) as {
			url: string;
			username: string;
			password: string;
		};
		const laptop = await Session.open({ url: creds.url, auth: async () => creds });
		await laptop.commit([{ path: "ops/deploy.md", content: "---\ntitle: Deploy\n---\n\n- [setup] run deploy.sh\n" }], "memory: add ops/deploy.md (macbook, claude-code)", { name: "cy", email: "c@c" });
		const box = await inbox(cy, "cy");
		expect(box.items).toMatchObject([{ path: "ops/deploy.md", before: null, source: "claude-code on macbook" }]);

		// The user's own pushes (no "memory:" message) don't.
		const again = await Session.open({ url: creds.url, auth: async () => creds });
		await again.commit([{ path: "ops/manual.md", content: "---\ntitle: Manual\n---\n\nwritten by hand\n" }], "notes from my editor", { name: "cy", email: "c@c" });
		expect((await inbox(cy, "cy")).items.map((i: { path: string }) => i.path)).toEqual(["ops/deploy.md"]);
	});
});
