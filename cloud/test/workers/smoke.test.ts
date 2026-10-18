import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("serves the landing page and protected resource metadata", async () => {
	const home = await SELF.fetch("https://memory.test/");
	expect(home.status).toBe(200);
	expect(await home.text()).toContain("Sign in with GitHub");
	const meta = await SELF.fetch("https://memory.test/.well-known/oauth-protected-resource/mcp");
	expect(meta.status).toBe(200);
	expect(await meta.json()).toMatchObject({ resource: "https://memory.test/mcp" });
	const mcp = await SELF.fetch("https://memory.test/mcp", { method: "POST" });
	expect(mcp.status).toBe(401);
});

it("serves the app icon", async () => {
	const svg = await SELF.fetch("https://memory.test/favicon.svg");
	expect(svg.headers.get("Content-Type")).toBe("image/svg+xml");
	expect(await svg.text()).toContain("<svg");
	for (const path of ["/favicon.ico", "/apple-touch-icon.png", "/icon-512.png"]) {
		const png = new Uint8Array(await (await SELF.fetch(`https://memory.test${path}`)).arrayBuffer());
		expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join(""), path).toBe("PNG");
	}
	expect(await (await SELF.fetch("https://memory.test/")).text()).toContain('rel="icon" href="/favicon.svg"');
});
