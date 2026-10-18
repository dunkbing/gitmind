import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("leaves the landing page to the static site, and protects /mcp", async () => {
	// The built site (site/dist) serves "/" in production; see
	// test/node/site.test.ts. Without assets the Worker sends people to the app.
	const home = await SELF.fetch("https://memory.test/", { redirect: "manual" });
	expect(home.headers.get("Location")).toBe("/app");
	const meta = await SELF.fetch("https://memory.test/.well-known/oauth-protected-resource/mcp");
	expect(meta.status).toBe(200);
	expect(await meta.json()).toMatchObject({ resource: "https://memory.test/mcp" });
	const mcp = await SELF.fetch("https://memory.test/mcp", { method: "POST" });
	expect(mcp.status).toBe(401);
});

