import { describe, expect, it } from "vitest";
import { connect, signedIn, tool } from "./helpers";

// Semantic search with the deterministic test embedder (DEV_EMBEDDINGS),
// which matches similar wording rather than meaning; Workers AI's model
// is what makes it semantic in production. The pipeline is the same.
describe("semantic search", () => {
	it("embeds notes in the background and finds them without the exact words", async () => {
		const ana = await signedIn("ana");
		const { token } = await connect(ana);
		await tool(token, "write_note", { title: "Shipping releases", directory: "ops", content: "- [setup] We deploy with the release script on Fridays" });
		await tool(token, "write_note", { title: "Lunch spots", directory: "life", content: "- [preference] Pho on Tuesdays near the office" });

		// "deployments" shares no word with the note (keyword search uses
		// whole-word prefixes), but is close in wording to "deploy".
		expect((await tool(token, "search_notes", { query: "deployments", mode: "keyword" })).text).toBe("No notes match.");
		let found = "";
		for (let i = 0; i < 40 && !found.includes("ops/shipping-releases.md"); i++) {
			await new Promise((r) => setTimeout(r, 250)); // the embedding alarm runs shortly after the write
			found = (await tool(token, "search_notes", { query: "deployments" })).text;
		}
		expect(found).toContain("ops/shipping-releases.md");
		expect(found).not.toContain("life/lunch-spots.md");

		// Filters apply to semantic matches too.
		expect((await tool(token, "search_notes", { query: "deployments", directory: "life" })).text).toBe("No notes match.");

		// Related notes, by meaning, for the web app's side panel.
		await tool(token, "write_note", { title: "Release checklist", directory: "ops", content: "- [setup] Run the release script, then deploy" });
		let related: { path: string }[] = [];
		for (let i = 0; i < 40 && !related.some((h) => h.path === "ops/release-checklist.md"); i++) {
			await new Promise((r) => setTimeout(r, 250));
			const res = await ana.fetch("/api/app/w/ana/related?path=ops/shipping-releases.md");
			related = (await res.json()) as { path: string }[];
		}
		expect(related.map((h) => h.path)).toContain("ops/release-checklist.md");
		expect(related.map((h) => h.path)).not.toContain("ops/shipping-releases.md");
	});
});
