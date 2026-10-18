import { readdirSync } from "node:fs";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { lastModified, newest } from "./src/lib/site.mjs";

const docFiles = readdirSync(new URL("./src/content/docs/", import.meta.url)).map((f) => `src/content/docs/${f}`);

// lastmod for the sitemap, from git: a doc page's Markdown file, the docs index
// from all of them, and the home page from its source.
function lastmod(url) {
	const path = new URL(url).pathname;
	if (path === "/") return lastModified("src/pages/index.astro");
	if (path === "/docs/") return newest(["src/pages/docs/index.astro", ...docFiles]);
	const doc = path.match(/^\/docs\/([^/]+)\/$/);
	return doc ? lastModified(`src/content/docs/${doc[1]}.md`) : undefined;
}

// The marketing site and docs, built to static HTML that the Worker serves as
// assets. The app pages (/app, /w/…) are rendered by the Worker itself.
export default defineConfig({
	site: "https://gitmind.app",
	trailingSlash: "always",
	integrations: [
		mdx(),
		sitemap({
			serialize(item) {
				const date = lastmod(item.url);
				return date ? { ...item, lastmod: date.toISOString() } : item;
			},
		}),
	],
	vite: { plugins: [tailwindcss()] },
	markdown: { shikiConfig: { themes: { light: "github-light", dark: "github-dark" } } },
});
