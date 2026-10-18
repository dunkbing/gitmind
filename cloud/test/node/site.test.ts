// Checks the built marketing site and docs (run `bun run build` in site/
// first): the files the Worker serves as static assets.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dist = new URL("../../site/dist/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, dist), "utf8");

describe.skipIf(!existsSync(dist))("built site", () => {
	it("has the icons and the app stylesheet", () => {
		expect(read("favicon.svg")).toContain("<svg");
		for (const png of ["favicon.ico", "apple-touch-icon.png", "icon-512.png"]) {
			expect(readFileSync(new URL(png, dist)).subarray(1, 4).toString(), png).toBe("PNG");
		}
		const css = read("app.css");
		for (const cls of [".btn", ".cat", ".hits", "iA Writer Quattro"]) expect(css, cls).toContain(cls);
	});

	it("is set up for search engines and AI assistants", () => {
		const home = read("index.html");
		expect(home).toContain('<link rel="canonical" href="https://gitmind.app/"');
		expect(home).toContain('"@type":"SoftwareApplication"');
		expect(home).toContain('rel="icon" href="/favicon.svg"');
		expect(read("robots.txt")).toContain("Sitemap: https://gitmind.app/sitemap-index.xml");
		expect(read("sitemap-0.xml")).toContain("https://gitmind.app/docs/quickstart/");
		const llms = read("llms.txt");
		expect(llms).toMatch(/^# gitmind\n\n> /);
		expect(llms).toContain("[Quickstart](https://gitmind.app/docs/quickstart/)");
		expect(read("llms-full.txt")).toContain("# MCP tools");
		const doc = read("docs/connect/index.html");
		expect(doc).toContain('"@type":"TechArticle"');
		expect(doc.replace(/<[^>]+>/g, "")).toContain("claude mcp add --transport http"); // code is highlighted into spans
	});
});
