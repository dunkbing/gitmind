// Search engines and AI crawlers (named explicitly, so the intent is clear) may
// read the site and docs; the app, sign-in and API routes are off limits.
// "/app$" rather than "/app", which would also block /app.css and /apple-touch-icon.png.
const agents = ["*", "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Google-Extended", "Googlebot", "Bingbot", "Applebot-Extended", "CCBot"];
const disallow = ["/app$", "/app/", "/_app/", "/w/", "/authorize", "/invite/", "/login", "/logout", "/connect", "/mcp", "/oauth/", "/auth/", "/dev/"];

export function GET() {
	const body = `${agents.map((a) => `User-agent: ${a}`).join("\n")}\nAllow: /\n${disallow.map((p) => `Disallow: ${p}`).join("\n")}\n\nSitemap: https://gitmind.app/sitemap-index.xml\n`;
	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
