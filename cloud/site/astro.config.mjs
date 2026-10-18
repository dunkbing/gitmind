import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// The marketing site and docs, built to static HTML that the Worker serves as
// assets. The app pages (/app, /w/…) are rendered by the Worker itself.
export default defineConfig({
	site: "https://gitmind.app",
	trailingSlash: "always",
	integrations: [mdx(), sitemap()],
	vite: { plugins: [tailwindcss()] },
	markdown: { shikiConfig: { themes: { light: "github-light", dark: "github-dark" } } },
});
