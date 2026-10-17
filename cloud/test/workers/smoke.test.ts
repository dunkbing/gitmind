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
