// Bindings and settings not declared in wrangler.jsonc.
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
	interface Env {
		// Optional: without it, sign-in uses GitHub's device flow.
		GITHUB_CLIENT_SECRET?: string;
		// Tests only: point GitHub calls at a fake.
		GITHUB_WEB_URL?: string;
		GITHUB_API_URL?: string;
		// Local development and tests only: use a plain git HTTP server
		// instead of Artifacts, and allow /dev/login without GitHub.
		DEV_GIT_BASE?: string;
		DEV_LOGIN?: string;
		FRESHNESS_MS?: string;
		// Tests and local development: semantic search with a simple local
		// embedding instead of Workers AI.
		DEV_EMBEDDINGS?: string;
		OAUTH_PROVIDER: OAuthHelpers;
	}
}
