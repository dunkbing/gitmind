import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The app is served by the Worker at /app and /w/... from the static assets,
// so it builds into the site's output under /_app/.
export default defineConfig({
	base: "/_app/",
	plugins: [react(), tailwindcss()],
	build: { outDir: "../site/dist/_app", emptyOutDir: true },
	server: { proxy: { "/api": "http://localhost:8787", "/login": "http://localhost:8787", "/dev": "http://localhost:8787", "/fonts": "http://localhost:8787" } },
});
