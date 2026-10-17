// Bindings and settings not declared in wrangler.jsonc.
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
	interface Env {
		GITHUB_CLIENT_SECRET: string;
		// Local development and tests only: use a plain git HTTP server
		// instead of Artifacts, and allow /dev/login without GitHub.
		DEV_GIT_BASE?: string;
		DEV_LOGIN?: string;
		FRESHNESS_MS?: string;
		OAUTH_PROVIDER: OAuthHelpers;
	}
}
