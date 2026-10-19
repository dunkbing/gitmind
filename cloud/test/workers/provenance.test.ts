import { describe, expect, it } from "vitest";
import { type Browser, connect, signedIn, tool } from "./helpers";

async function call<T = any>(b: Browser, method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
	const res = await b.fetch("/api/app" + url, {
		method,
		headers: { "X-Gitmind": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	return { status: res.status, data: (await res.json()) as T };
}

describe("provenance", () => {
	it("says in every commit who made a change, and with which app", async () => {
		const bo = await signedIn("bo");
		const { token } = await connect(bo, { clientName: "claude.ai" });
		await call(bo, "POST", "/w/bo/notes", { title: "Stack", directory: "dev", content: "- [decision] Use Postgres" });
		await tool(token, "edit_note", { identifier: "Stack", operation: "append", content: "- [decision] Use Redis for queues" });

		const history = (await call(bo, "GET", "/w/bo/history")).data.map((c: { message: string }) => c.message);
		expect(history).toContain("memory: add dev/stack.md (cloud, bo)");
		expect(history).toContain("memory: edit dev/stack.md (cloud, bo, claude.ai)");
		// Agents' changes take effect at once; nothing waits for review.
		expect((await call(bo, "GET", "/w/bo/note?path=dev/stack.md")).data.content).toContain("Use Redis for queues");
		expect((await call(bo, "GET", "/w/bo/inbox")).status).toBe(404);
	});
});
