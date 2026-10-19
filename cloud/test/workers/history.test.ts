import { describe, expect, it } from "vitest";
import { connect, signedIn, tool } from "./helpers";

describe("facts that change", () => {
	it("flags conflicting facts, supersedes them, and leaves History out of search", async () => {
		const ann = await signedIn("ann");
		const { token } = await connect(ann);
		await tool(token, "write_note", { title: "Search", directory: "myapp", content: "- [decision] use bge-m3 embeddings for semantic search #search\n- [setup] the index lives in SQLite" });
		await tool(token, "write_note", { title: "Style", directory: "general", content: "- [preference] tabs, not spaces" });

		// A new fact about the same thing is flagged; an unrelated one, and
		// facts in other projects, are not.
		let out = (await tool(token, "write_note", {
			title: "Embeddings", directory: "myapp",
			content: "- [decision] use Qwen3 embeddings, which rank notes better than bge-m3\n- [decision] cache vectors per passage",
		})).text;
		expect(out).toContain("Possibly conflicting facts");
		expect(out).toContain("existing in myapp/search.md: [decision] use bge-m3 embeddings for semantic search #search");
		expect(out).not.toContain("cache vectors");
		out = (await tool(token, "write_note", { title: "Other", directory: "otherapp", content: "- [decision] use bge-m3 embeddings for semantic search" })).text;
		expect(out).not.toContain("conflicting");
		out = (await tool(token, "edit_note", { identifier: "myapp/search.md", operation: "append", content: "- [preference] Tabs, not spaces" })).text;
		expect(out).toContain("existing in general/style.md: [preference] tabs, not spaces (same wording)");

		// Supersede the outdated decision.
		out = (await tool(token, "edit_note", {
			identifier: "myapp/search.md", operation: "supersede",
			find_text: "[decision] use bge-m3 embeddings for semantic search", content: "- [decision] use Qwen3 embeddings for semantic search #search",
		})).text;
		expect(out).toContain("moved to History");
		const note = (await tool(token, "read_note", { identifier: "myapp/search.md" })).text;
		const today = new Date().toISOString().slice(0, 10);
		expect(note).toContain("\n- [decision] use Qwen3 embeddings for semantic search #search\n");
		expect(note.endsWith(`## History\n\n- [decision] use bge-m3 embeddings for semantic search #search (replaced ${today})\n`)).toBe(true);
		const missing = await tool(token, "edit_note", { identifier: "myapp/search.md", operation: "supersede", find_text: "use FAISS", content: "x" });
		expect(missing.isError).toBe(true);
		expect(missing.text).toContain("current facts");

		// Search leaves the replaced fact out unless asked for history.
		out = (await tool(token, "search_notes", { query: "bge-m3", directory: "myapp", mode: "keyword" })).text;
		expect(out).not.toContain("search.md");
		out = (await tool(token, "search_notes", { query: "bge-m3", directory: "myapp", mode: "keyword", include_history: true })).text;
		expect(out).toContain("myapp/search.md");
		expect(out).toContain("[history]");
		out = (await tool(token, "search_notes", { category: "decision", directory: "myapp" })).text;
		expect(out).not.toContain("bge-m3 embeddings for semantic");
		expect(out).toContain("use Qwen3 embeddings for semantic search");
	});
});

describe("handoff", () => {
	it("tells the project's next session where the last one left off, until the work is done", async () => {
		const ola = await signedIn("ola");
		const { token } = await connect(ola, { clientName: "Claude Code" });
		await tool(token, "write_note", { title: "Stack", directory: "shop", content: "- [decision] Postgres" });
		let out = (await tool(token, "handoff", { project: "shop", content: "Migrating orders to SQLite: backfill fails on NULL prices.\nNext: fix the backfill." })).text;
		expect(out).toContain("shop/handoff.md");

		const ctx = (await tool(token, "project_context", { project: "shop" })).text;
		const section = ctx.slice(ctx.indexOf("## Where we left off"));
		expect(section).toContain("backfill fails on NULL prices");
		expect(section).toContain("_Left by Claude Code");
		expect(ctx.slice(ctx.indexOf("## Project notes"))).not.toContain("Handoff");
		expect((await tool(token, "project_context", { project: "blog" })).text).not.toContain("Where we left off");

		out = (await tool(token, "handoff", { project: "shop", content: "" })).text;
		expect(out).toContain("Cleared");
		expect((await tool(token, "project_context", { project: "shop" })).text).not.toContain("Where we left off");
		expect((await tool(token, "handoff", { project: "", content: "x" })).isError).toBe(true);
	});
});
