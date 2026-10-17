import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Session } from "../../src/repo/git";
import { BASE, connect, deny, listTools, signedIn, tool } from "./helpers";

describe("remote MCP endpoint", () => {
	it("signs in like an MCP client and serves every tool", async () => {
		const alice = await signedIn("alice");
		const { token, refresh } = await connect(alice);
		expect(refresh).toBeTruthy();
		expect(await listTools(token)).toEqual([
			"build_context", "delete_note", "edit_note", "list_notes", "list_workspaces", "move_note",
			"pin_note", "project_context", "read_note", "recent_activity", "search_notes", "write_note",
		]);

		expect((await tool(token, "list_workspaces")).text).toContain("alice (personal, owner) [default]");

		let r = await tool(token, "write_note", { title: "Stripe webhooks", directory: "shop", content: "- [gotcha] verify signatures with the raw body #payments" });
		expect(r).toEqual({ text: "Created shop/stripe-webhooks.md", isError: false });
		r = await tool(token, "write_note", { title: "Billing", directory: "shop", content: "- depends on [[Stripe webhooks]]\n- [decision] invoices are immutable" });
		expect(r.text).toContain("Created shop/billing.md");

		// Duplicate hint and the overwrite guard.
		r = await tool(token, "write_note", { title: "Stripe refunds", directory: "shop", content: "- [decision] refunds via dashboard" });
		expect(r.text).toContain("Possibly overlapping notes");
		expect(r.text).toContain("shop/stripe-webhooks.md");
		r = await tool(token, "write_note", { title: "Billing", directory: "shop", content: "clobber" });
		expect(r.isError).toBe(true);
		expect(r.text).toContain("edit_note");

		// Search: text, category filter, tag filter.
		expect((await tool(token, "search_notes", { query: "invoices immutable" })).text).toContain("shop/billing.md");
		r = await tool(token, "search_notes", { category: "decision", directory: "shop" });
		expect(r.text).toContain("invoices are immutable");
		expect(r.text).toContain("refunds via dashboard");
		expect((await tool(token, "search_notes", { tags: ["payments"], since: "7d" })).text).toContain("shop/stripe-webhooks.md");
		expect((await tool(token, "search_notes", {})).isError).toBe(true);

		// Edits, sections, links and context.
		r = await tool(token, "edit_note", { identifier: "Billing", operation: "append", content: "- [decision] credit notes for corrections" });
		expect(r.text).toBe("Edited shop/billing.md");
		r = await tool(token, "edit_note", { identifier: "Billing", operation: "replace_section", section: "Open questions", content: "- refunds?" });
		expect(r.text).toContain("was added at the end");
		r = await tool(token, "build_context", { identifier: "Billing" });
		expect(r.text).toContain("depends on [[Stripe webhooks]] (shop/stripe-webhooks.md): - [gotcha] verify signatures");
		r = await tool(token, "read_note", { identifier: "shop/stripe-webhooks" });
		expect(r.text).toContain("Linked from: [[Billing]]");

		// Moving keeps links working.
		r = await tool(token, "move_note", { identifier: "Stripe webhooks", directory: "payments", title: "Stripe events" });
		expect(r.text).toBe("Moved to payments/stripe-events.md; updated links in shop/billing.md");
		expect((await tool(token, "read_note", { identifier: "Billing" })).text).toContain("[[Stripe events]]");

		// Pins and session context.
		await tool(token, "write_note", { title: "Coding style", directory: "general", content: "- [preference] small commits", pinned: true });
		r = await tool(token, "project_context", { project: "shop" });
		expect(r.text).toContain("## Pinned notes\n\n### Coding style (general/coding-style.md)");
		expect(r.text).toContain("## Project notes (shop)");

		// Secrets are refused.
		r = await tool(token, "write_note", { title: "Keys", content: "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx" });
		expect(r.isError).toBe(true);
		expect(r.text).toContain("refusing to save");

		expect((await tool(token, "delete_note", { identifier: "Stripe refunds" })).text).toBe("Deleted shop/stripe-refunds.md");
		expect((await tool(token, "recent_activity", {})).text).not.toContain("stripe-refunds");
	});

	it("rejects missing and foreign tokens, and honours Deny", async () => {
		const res = await SELF.fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: "{}" });
		expect(res.status).toBe(401);
		const carol = await signedIn("carol");
		expect(await deny(carol)).toBe("access_denied");
	});

	it("sees notes pushed with git from a laptop, and gives the CLI git credentials", async () => {
		const dave = await signedIn("dave");
		const { token } = await connect(dave, { clientName: "memory-go CLI" });
		const me = await SELF.fetch(`${BASE}/mcp/api/me`, { headers: { Authorization: `Bearer ${token}` } });
		expect(await me.json()).toMatchObject({ login: "dave", workspaces: [{ slug: "dave", kind: "personal", role: "owner" }] });

		const credsRes = await SELF.fetch(`${BASE}/mcp/api/workspaces/dave/git-credentials`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
		expect(credsRes.status).toBe(200);
		const creds = (await credsRes.json()) as { url: string; username: string; password: string };
		expect(creds.url).toMatch(/\/ws-[0-9a-f]+\.git$/);

		// The "laptop" pushes a note with plain git semantics.
		const laptop = await Session.open({ url: creds.url, auth: async () => ({ username: creds.username, password: creds.password }) });
		expect(laptop.blobs.has(".gitattributes")).toBe(true);
		await laptop.commit([{ path: "general/from-laptop.md", content: "---\ntitle: From laptop\n---\n\n- [setup] pushed with git\n" }], "memory: add from laptop", { name: "dave", email: "d@d" });
		expect((await tool(token, "search_notes", { query: "pushed with git" })).text).toContain("general/from-laptop.md");

		// A cloud write after the laptop push lands on top of it.
		await tool(token, "edit_note", { identifier: "From laptop", operation: "append", content: "- [setup] edited in the cloud" });
		const check = await Session.open({ url: creds.url, auth: async () => creds });
		expect(await check.read("general/from-laptop.md")).toContain("edited in the cloud");

		const other = await SELF.fetch(`${BASE}/mcp/api/workspaces/alice/git-credentials`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
		expect(other.status).toBe(404);
	});
});
