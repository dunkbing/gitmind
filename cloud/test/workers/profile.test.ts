import { describe, expect, it } from "vitest";
import { connect, signedIn, tool } from "./helpers";

describe("profile", () => {
	it("starts every session with the user's standing instructions and preferences", async () => {
		const di = await signedIn("di");
		const { token } = await connect(di);
		await tool(token, "write_note", { title: "Working style", directory: "general", content: "- [instruction] One-line commit messages #git\n- [preference] Use bun, not npm\n- [decision] Not part of it\n\n## History\n\n- [instruction] Long commit bodies (until 2026-10-01)" });
		await tool(token, "write_note", { title: "Shop rules", directory: "shop", content: "- [instruction] Prices are in cents" });
		await tool(token, "write_note", { title: "Blog rules", directory: "blog", content: "- [instruction] Only for the blog" });

		const out = (await tool(token, "project_context", { project: "shop" })).text;
		const profile = out.slice(out.indexOf("## Profile"), out.indexOf("## Project notes"));
		expect(profile).toContain("- [instruction] One-line commit messages (Working style)");
		expect(profile).toContain("- [instruction] Prices are in cents (Shop rules)");
		expect(profile).toContain("- [preference] Use bun, not npm (Working style)");
		expect(profile).not.toContain("Long commit bodies");
		expect(profile).not.toContain("Only for the blog");
		expect(profile).not.toContain("Not part of it");
		expect(profile.indexOf("[preference]")).toBeGreaterThan(profile.indexOf("Prices are in cents"));

		// A small budget still fits the essentials.
		const small = (await tool(token, "project_context", { project: "shop", budget: 1200 })).text;
		expect(small.length).toBeLessThan(1600);
		expect(small).toContain("## Profile");

		const res = await di.fetch("/api/app/w/di/profile");
		const facts = (await res.json()) as { text: string }[];
		expect(facts.map((f) => f.text)).toEqual(["One-line commit messages", "Use bun, not npm"]);
	});
});
