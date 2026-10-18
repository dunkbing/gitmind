// The API the gitmind CLI calls with an OAuth access token, to find its
// workspaces, get short-lived git credentials for them, and search them by
// meaning (the CLI's own index is keyword-only).

import { getUser, workspaceFor, workspacesFor, workspaceStub } from "./accounts";
import { type AuthProps, toQuery } from "./mcp";
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

	// POST /mcp/api/workspaces/:slug/search, body as search_notes' arguments → Hit[]
	const sm = /^\/mcp\/api\/workspaces\/([^/]+)\/search$/.exec(path);
	if (request.method === "POST" && sm) {
		const ws = await workspaceFor(env, user.id, decodeURIComponent(sm[1]));
		if (!ws) return json({ error: "no such workspace, or you're not a member" }, 404);
		const a = (await request.json()) as Parameters<typeof toQuery>[0] & { mode?: "hybrid" | "keyword" | "semantic" };
		try {
			return json(await workspaceStub(env, ws).search({ ...toQuery(a, Date.now()), mode: a.mode }));
		} catch (e) {
			return json({ error: (e as Error).message }, 400);
		}
	}

	return json({ error: "not found" }, 404);
}
