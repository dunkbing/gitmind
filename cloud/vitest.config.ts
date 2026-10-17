import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");
	return {
		test: {
			projects: [
				// Code that runs anywhere (git layer, engine, import), tested in
				// Node against a real git HTTP server.
				{ test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node", testTimeout: 30000 } },
				// The Worker itself, inside workerd. A local git server stands
				// in for Artifacts.
				{
					plugins: [
						cloudflareTest({
							wrangler: { configPath: "./wrangler.test.jsonc" },
							miniflare: {
								bindings: {
									PUBLIC_URL: "https://memory.test",
									GITHUB_CLIENT_ID: "test",
									GITHUB_CLIENT_SECRET: "test",
									DEV_GIT_BASE: "http://127.0.0.1:18765",
									DEV_LOGIN: "1",
									FRESHNESS_MS: "0",
									TEST_MIGRATIONS: migrations,
								},
							},
						}),
					],
					test: {
						name: "workers",
						include: ["test/workers/**/*.test.ts"],
						globalSetup: ["./test/global-setup.ts"],
						setupFiles: ["./test/workers/apply-migrations.ts"],
						testTimeout: 30000,
					},
				},
			],
		},
	};
});
