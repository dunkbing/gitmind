// memory-go cloud: one Worker serving the remote MCP endpoint, the OAuth
// authorization server, the CLI's API and the web app.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { api } from "./api";
import { type AuthProps, mcpHandler } from "./mcp";
import { web } from "./web/app";

export { Workspace } from "./workspace/workspace";

const VERSION = "0.1.0";

// The provider and MCP handler depend on PUBLIC_URL, so they're built on the
// first request of each isolate rather than at import time.
let provider: OAuthProvider<Env> | null = null;
let mcp: ReturnType<typeof mcpHandler> | null = null;

function build(env: Env): OAuthProvider<Env> {
	const base = env.PUBLIC_URL.replace(/\/+$/, "");
	mcp = mcpHandler(VERSION, new URL(base).hostname);
	return new OAuthProvider<Env>({
		// The CLI's API lives under /mcp/api/ so the same access token, issued
		// for the /mcp resource, covers it (RFC 8707 audiences).
		apiRoute: "/mcp",
		apiHandler: {
			fetch(request: Request, env: Env, ctx: ExecutionContext) {
				const props = (ctx as ExecutionContext & { props: AuthProps }).props;
				if (new URL(request.url).pathname.startsWith("/mcp/api/")) return api(request, env, props);
				return mcp!(request, env, ctx);
			},
		},
		defaultHandler: { fetch: (request: Request, env: Env, ctx: ExecutionContext) => web.fetch(request, env, ctx) },
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/oauth/token",
		clientRegistrationEndpoint: "/oauth/register",
		clientIdMetadataDocumentEnabled: true,
		scopesSupported: ["memory", "offline_access"],
		requiredScopes: ["memory"],
		resourceMetadata: { resource: `${base}/mcp`, authorization_servers: [base] },
		// Logins last 90 days, and lapse after 30 days unused.
		refreshTokenTTL: 90 * 86400,
		refreshTokenIdleTTL: 30 * 86400,
	});
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		provider ??= build(env);
		return provider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
