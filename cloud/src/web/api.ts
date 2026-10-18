// The web app's JSON API, under /api/app/. It uses the same session cookie as
// the rest of the site; the single-page app in cloud/app is its only client.

import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import {
	type User,
	type Workspace,
	canManage,
	createInvite,
	createWorkspace,
	members,
	removeMember,
	sessionUser,
	workspacesFor,
	workspaceStub,
} from "../accounts";
import { parseExport } from "../import";
import { actorOf, parseWhen } from "../mcp";

type Env_ = { Bindings: Env; Variables: { user: User } };
type C = Context<Env_>;

export const SESSION = "mg_session";

export const appApi = new Hono<Env_>();

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error: /, "");

// setupCommand is the CLI command that connects a laptop to this server:
// plain `gitmind setup` for gitmind.app, with --server elsewhere.
export const setupCommand = (env: Env, workspace?: string) =>
	"gitmind setup" + (env.PUBLIC_URL.replace(/\/+$/, "") === "https://gitmind.app" ? "" : ` --server ${env.PUBLIC_URL}`) + (workspace ? ` --workspace ${workspace}` : "");

export async function sha256(text: string): Promise<string> {
	const sum = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(sum)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Every request needs a session. Changes also need the X-Gitmind header,
// which a cross-site page can't send without a CORS preflight we never allow.
appApi.use("*", async (c, next) => {
	const user = await sessionUser(c.env, getCookie(c, SESSION));
	if (!user) return c.json({ error: "Sign in first." }, 401);
	if (c.req.method !== "GET" && c.req.header("X-Gitmind") !== "1") return c.json({ error: "Missing X-Gitmind header." }, 403);
	c.set("user", user);
	await next();
});

appApi.onError((e, c) => c.json({ error: errMessage(e) }, 400));

async function workspace(c: C): Promise<Workspace | null> {
	const all = await workspacesFor(c.env, c.get("user").id);
	return all.find((w) => w.slug === c.req.param("slug")) ?? null;
}

const noWorkspace = (c: C) => c.json({ error: "No such workspace, or you're not a member." }, 404);

appApi.get("/me", async (c) => {
	const user = c.get("user");
	return c.json({
		user: { id: user.id, login: user.login, name: user.name, avatar_url: user.avatar_url },
		workspaces: await workspacesFor(c.env, user.id),
		mcpUrl: `${c.env.PUBLIC_URL.replace(/\/+$/, "")}/mcp`,
		setupCommand: setupCommand(c.env),
	});
});

appApi.get("/w/:slug/notes", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	return c.json(await workspaceStub(c.env, ws).list(""));
});

appApi.get("/w/:slug/note", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	try {
		const note = await workspaceStub(c.env, ws).readNote(c.req.query("path") ?? "");
		return c.json({ ...note, hash: await sha256(note.content) });
	} catch (e) {
		return c.json({ error: errMessage(e) }, 404);
	}
});

// Saving sends the hash of the content the editor started from; if the note
// changed since (another tab, an agent, a sync), nothing is written and the
// current version comes back with 409.
appApi.put("/w/:slug/note", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	const { path, content, base } = await c.req.json<{ path: string; content: string; base?: string }>();
	const stub = workspaceStub(c.env, ws);
	if (base) {
		const current = await stub.readNote(path);
		if ((await sha256(current.content)) !== base) return c.json({ error: "This note changed since you opened it.", current: { ...current, hash: await sha256(current.content) } }, 409);
	}
	await stub.put(path, content, actorOf(c.get("user")), false);
	const saved = await stub.readNote(path);
	return c.json({ ...saved, hash: await sha256(saved.content) });
});

appApi.post("/w/:slug/notes", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	const b = await c.req.json<{ title: string; directory?: string; content?: string; tags?: string[] }>();
	const r = await workspaceStub(c.env, ws).write({ title: b.title, directory: b.directory ?? "", content: b.content ?? "", tags: b.tags ?? [] }, actorOf(c.get("user")));
	return c.json(r);
});

appApi.post("/w/:slug/move", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	const b = await c.req.json<{ path: string; directory?: string; title?: string }>();
	return c.json(await workspaceStub(c.env, ws).move(b.path, b.directory, b.title, actorOf(c.get("user"))));
});

appApi.post("/w/:slug/pin", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	const b = await c.req.json<{ path: string; pinned: boolean }>();
	return c.json({ path: await workspaceStub(c.env, ws).pin(b.path, b.pinned, actorOf(c.get("user"))) });
});

appApi.delete("/w/:slug/note", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	return c.json({ path: await workspaceStub(c.env, ws).delete(c.req.query("path") ?? "", actorOf(c.get("user"))) });
});

appApi.get("/w/:slug/search", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	const q = c.req.query();
	const hits = await workspaceStub(c.env, ws).search({
		text: q.q ?? "",
		tags: q.tag ? [q.tag] : [],
		category: q.category ?? "",
		since: parseWhen(q.since ?? "", Date.now()),
		limit: Math.min(100, Number(q.limit) || 30),
	});
	return c.json(hits);
});

appApi.get("/w/:slug/graph", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	return c.json(await workspaceStub(c.env, ws).graph());
});

appApi.get("/w/:slug/history", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	return c.json(await workspaceStub(c.env, ws).history(Math.min(200, Number(c.req.query("limit")) || 50)));
});

appApi.post("/w/:slug/import", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	const file = (await c.req.parseBody()).file;
	if (!(file instanceof File)) return c.json({ error: "Choose a file to import." }, 400);
	const parsed = parseExport(file.name, new Uint8Array(await file.arrayBuffer()));
	if (!parsed.files.length) return c.json({ error: "Nothing to import in that file." }, 400);
	const r = await workspaceStub(c.env, ws).importFiles(parsed.files, actorOf(c.get("user")), `import ${parsed.files.length} notes from ${parsed.source}`);
	return c.json({ source: parsed.source, ...r });
});

appApi.get("/w/:slug/settings", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	return c.json({
		stats: await workspaceStub(c.env, ws).stats(),
		members: ws.kind === "team" ? await members(c.env, ws.id) : [],
		canManage: canManage(ws),
		setupCommand: setupCommand(c.env, ws.kind === "team" ? ws.slug : undefined),
	});
});

appApi.post("/teams", async (c) => {
	const name = String((await c.req.json<{ name?: string }>()).name ?? "").trim();
	if (!name) return c.json({ error: "Give the team a name." }, 400);
	return c.json(await createWorkspace(c.env, c.get("user"), name, "team"));
});

appApi.post("/w/:slug/invites", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	const role = (await c.req.json<{ role?: string }>()).role === "admin" ? "admin" : "member";
	const code = await createInvite(c.env, ws, c.get("user"), role);
	return c.json({ url: `${c.env.PUBLIC_URL}/invite/${code}`, role });
});

appApi.post("/w/:slug/members/:userId/remove", async (c) => {
	const ws = await workspace(c);
	if (!ws) return noWorkspace(c);
	await removeMember(c.env, ws, c.get("user"), c.req.param("userId"));
	return c.json({ ok: true });
});

appApi.all("*", (c) => c.json({ error: "Not found" }, 404));
