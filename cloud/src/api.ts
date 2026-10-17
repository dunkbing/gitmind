// The API the memory-go CLI calls with an OAuth access token, to find its
// workspaces and get short-lived git credentials for them.

import { getUser, workspaceFor, workspacesFor } from "./accounts";
import type { AuthProps } from "./mcp";
import { repoProvider } from "./repo/provider";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export async function api(request: Request, env: Env, props: AuthProps): Promise<Response> {
	const user = await getUser(env, props.userId);
	if (!user) return json({ error: "account not found" }, 401);
	const path = new URL(request.url).pathname;

	if (request.method === "GET" && path === "/mcp/api/me") {
		const all = await workspacesFor(env, user.id);
		return json({ login: user.login, workspaces: all.map(({ slug, name, kind, role }) => ({ slug, name, kind, role })) });
	}

	// POST /mcp/api/workspaces/:slug/git-credentials → { url, username, password, expiresAt }
	const m = /^\/mcp\/api\/workspaces\/([^/]+)\/git-credentials$/.exec(path);
	if (request.method === "POST" && m) {
		const ws = await workspaceFor(env, user.id, decodeURIComponent(m[1]));
		if (!ws) return json({ error: "no such workspace, or you're not a member" }, 404);
		const c = await repoProvider(env).credentials(ws.repo, "write", 3600);
		return json({ url: c.url, username: "x", password: c.token, expiresAt: new Date(c.expiresAt).toISOString() });
	}

	return json({ error: "not found" }, 404);
}
