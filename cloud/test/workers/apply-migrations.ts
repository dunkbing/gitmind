import { applyD1Migrations, env } from "cloudflare:test";

// TEST_MIGRATIONS is a test-only binding set in vitest.config.ts.
type Migrations = Parameters<typeof applyD1Migrations>[1];
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: Migrations }).TEST_MIGRATIONS);
