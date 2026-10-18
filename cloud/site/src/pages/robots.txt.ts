export function GET() {
	return new Response(
		"User-agent: *\nAllow: /\nDisallow: /w/\nDisallow: /app\nDisallow: /authorize\nDisallow: /invite/\n\nSitemap: https://gitmind.app/sitemap-index.xml\n",
		{ headers: { "Content-Type": "text/plain; charset=utf-8" } },
	);
}
