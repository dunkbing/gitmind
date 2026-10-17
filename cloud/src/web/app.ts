// The web app: sign-in, the OAuth consent page for MCP clients, and pages to
// browse, search, edit, import and share notes.

import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { strToU8, zipSync } from "fflate";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
	type User,
	type Workspace,
	acceptInvite,
	canManage,
	createInvite,
	createSession,
	createWorkspace,
	endSession,
	invite,
	members,
	removeMember,
	sessionUser,
	signIn,
	workspaceFor,
	workspacesFor,
	workspaceStub,
} from "../accounts";
import { linkTarget, parse, permalink } from "../engine/notes";
import { parseExport } from "../import";
import { actorOf, parseWhen } from "../mcp";
import { escape, page } from "./layout";
import { renderMarkdown } from "./markdown";

type Env_ = { Bindings: Env; Variables: { user: User | null } };
type C = Context<Env_>;

export const web = new Hono<Env_>();

const SESSION = "mg_session";
const STATE = "mg_login";
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const noteHref = (ws: Workspace, path: string) => `/w/${ws.slug}/n/${enc(path)}`;
const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error: /, "");

// Same-origin check for every form post, on top of SameSite cookies.
web.use("*", async (c, next) => {
	if (c.req.method === "POST") {
		const origin = c.req.header("Origin");
		if (origin && origin !== new URL(c.env.PUBLIC_URL).origin && origin !== new URL(c.req.url).origin) return c.text("Cross-site request refused", 403);
	}
	c.set("user", await sessionUser(c.env, getCookie(c, SESSION)));
	await next();
});

// requireUser redirects to sign-in, coming back to the current page.
function requireUser(c: C): User | Response {
	const user = c.get("user");
	if (user) return user;
	const u = new URL(c.req.url);
	return c.redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`);
}

async function loadWorkspace(c: C): Promise<{ user: User; ws: Workspace; all: Workspace[] } | Response> {
	const user = requireUser(c);
	if (user instanceof Response) return user;
	const all = await workspacesFor(c.env, user.id);
	const ws = all.find((w) => w.slug === c.req.param("slug"));
	if (!ws) return notFound(c, user, "No such workspace, or you're not a member.");
	return { user, ws, all };
}

const notFound = (c: C, user: User | null, message: string) => {
	const r = page({ title: "Not found", user }, `<h1>Not found</h1><p>${escape(message)}</p>`);
	return new Response(r.body, { status: 404, headers: r.headers });
};

// ---- sign-in -----------------------------------------------------------------

const safeNext = (next: string | undefined) => (next && next.startsWith("/") && !next.startsWith("//") ? next : "/");

web.get("/login", (c) => {
	if (c.env.DEV_LOGIN === "1" && c.req.query("dev")) return c.redirect(`/dev/login?login=${encodeURIComponent(c.req.query("dev")!)}&next=${encodeURIComponent(c.req.query("next") ?? "/")}`);
	const state = crypto.randomUUID();
	setCookie(c, STATE, `${state}|${safeNext(c.req.query("next"))}`, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
	const u = new URL("https://github.com/login/oauth/authorize");
	u.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
	u.searchParams.set("redirect_uri", `${c.env.PUBLIC_URL}/auth/github/callback`);
	u.searchParams.set("state", state);
	u.searchParams.set("scope", "read:user");
	return c.redirect(u.toString());
});

web.get("/auth/github/callback", async (c) => {
	const [state, next] = (getCookie(c, STATE) ?? "").split("|");
	deleteCookie(c, STATE, { path: "/", secure: true });
	if (!state || state !== c.req.query("state")) return page({ title: "Sign-in failed", error: "The sign-in link expired or was opened in another browser. Try again." }, `<p><a href="/login">Sign in again</a></p>`);
	if (c.req.query("error")) return page({ title: "Sign-in cancelled", error: "GitHub sign-in was cancelled." }, `<p><a href="/login">Try again</a></p>`);
	const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: c.env.GITHUB_CLIENT_ID,
			client_secret: c.env.GITHUB_CLIENT_SECRET,
			code: c.req.query("code"),
			redirect_uri: `${c.env.PUBLIC_URL}/auth/github/callback`,
		}),
	});
	const token = (await tokenRes.json()) as { access_token?: string; error_description?: string };
	if (!token.access_token) return page({ title: "Sign-in failed", error: `GitHub sign-in failed: ${token.error_description ?? "no token"}` }, "");
	const ghRes = await fetch("https://api.github.com/user", {
		headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "memory-go-cloud" },
	});
	if (!ghRes.ok) return page({ title: "Sign-in failed", error: `Couldn't read your GitHub profile (${ghRes.status}).` }, "");
	const gh = (await ghRes.json()) as { id: number; login: string; name?: string; avatar_url?: string };
	return finishSignIn(c, await signIn(c.env, gh), next);
});

// Local development and tests: sign in as any GitHub login without GitHub.
web.get("/dev/login", async (c) => {
	if (c.env.DEV_LOGIN !== "1") return c.notFound();
	const login = c.req.query("login") ?? "dev";
	let id = 0;
	for (const ch of login) id = (id * 31 + ch.charCodeAt(0)) % 1_000_000_007;
	return finishSignIn(c, await signIn(c.env, { id, login, name: login }), c.req.query("next"));
});

async function finishSignIn(c: C, user: User, next: string | undefined) {
	setCookie(c, SESSION, await createSession(c.env, user.id), { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 30 * 86400 });
	return c.redirect(safeNext(next));
}

web.post("/logout", async (c) => {
	await endSession(c.env, getCookie(c, SESSION));
	deleteCookie(c, SESSION, { path: "/", secure: true });
	return c.redirect("/");
});

// ---- OAuth consent for MCP clients and the CLI -----------------------------

web.get("/authorize", async (c) => {
	const user = requireUser(c);
	if (user instanceof Response) return user;
	const oauth = c.env.OAUTH_PROVIDER;
	try {
		const request = await oauth.parseAuthRequest(c.req.raw);
		const details = await oauth.describeConsent(request);
		const consent = await oauth.beginConsent(request);
		const origin = details.clientDomain
			? `Published by <strong>${escape(details.clientDomain)}</strong>.`
			: "This app registered itself, so its name isn't verified.";
		const res = page(
			{ title: `Authorize ${details.clientName}`, user },
			`<div class="hero card"><h1>Allow ${escape(details.clientName)} to use your memory?</h1>
			<p>${origin} Access goes to <strong>${escape(details.redirectHost)}</strong>.</p>
			${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it, e.g. with <code>memory-go setup --cloud</code>.</p>" : ""}
			<p>It will be able to read, search and change the notes in every workspace you belong to, as <strong>${escape(user.login)}</strong>.</p>
			<form method="post"><input type="hidden" name="handle" value="${escape(consent.handle)}">
			<div class="row"><button name="decision" value="approve">Allow</button><button class="plain" name="decision" value="deny">Deny</button></div></form></div>`,
		);
		for (const [k, v] of consent.headers) res.headers.set(k, v);
		return res;
	} catch (e) {
		return authorizeError(c, user, e);
	}
});

web.post("/authorize", async (c) => {
	const user = requireUser(c);
	if (user instanceof Response) return user;
	const oauth = c.env.OAUTH_PROVIDER;
	try {
		const form = await c.req.raw.clone().formData();
		const handle = String(form.get("handle"));
		if (form.get("decision") !== "approve") {
			const denied = await oauth.denyConsent(c.req.raw, handle);
			return new Response(null, { status: 302, headers: denied.headers });
		}
		const approved = await oauth.approveConsent(c.req.raw, handle);
		const { redirectTo } = await oauth.completeAuthorization({
			request: approved.request,
			userId: user.id,
			metadata: { login: user.login },
			scope: approved.request.scope,
			props: { userId: user.id },
		});
		approved.headers.set("Location", redirectTo);
		return new Response(null, { status: 302, headers: approved.headers });
	} catch (e) {
		return authorizeError(c, user, e);
	}
});

function authorizeError(c: C, user: User, e: unknown) {
	if (e instanceof AuthorizationError && e.redirectTo) return c.redirect(e.redirectTo);
	if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
		const message = e instanceof AuthorizationError ? e.description : "This app could not be verified.";
		const r = page({ title: "Authorization failed", user, error: message ?? "Invalid request" }, `<p>Start the connection again from the app.</p>`);
		return new Response(r.body, { status: 400, headers: r.headers });
	}
	throw e;
}

// ---- home and connect -------------------------------------------------------

web.get("/", async (c) => {
	const user = c.get("user");
	if (user) {
		const ws = await workspaceFor(c.env, user.id);
		if (ws) return c.redirect(`/w/${ws.slug}`);
	}
	return page(
		{ title: "Memory for your AI agents", user },
		`<div class="hero"><h1>One memory for Claude, ChatGPT, Codex and your coding agents.</h1>
		<p>memory-go keeps what your agents learn (decisions, preferences, gotchas, setup knowledge) as Markdown notes in a git repository you own,
		and serves them to every AI app over MCP: claude.ai, Claude Desktop and mobile, ChatGPT, Claude Code and Codex.</p>
		<ul><li>Search, links between notes, pinned notes, and a full history of every change.</li>
		<li>Your laptops sync the same notes with plain git through the <a href="https://github.com/dunkbing/memory-go">memory-go CLI</a>.</li>
		<li>Team workspaces share a memory between people and their agents.</li>
		<li>Open source (AGPL-3.0); self-host it on your own Cloudflare account.</li></ul>
		<p><a class="btn" href="/login">Sign in with GitHub</a></p></div>`,
	);
});

web.get("/connect", async (c) => {
	const user = requireUser(c);
	if (user instanceof Response) return user;
	const all = await workspacesFor(c.env, user.id);
	const mcp = `${c.env.PUBLIC_URL}/mcp`;
	return page(
		{ title: "Connect your AI apps", user, workspaces: all, current: all[0], active: "connect" },
		`<h1>Connect your AI apps</h1>
		<p>Every app connects to the same MCP endpoint and signs in as you:</p><pre class="box">${escape(mcp)}</pre>
		<h3>claude.ai, Claude Desktop and Claude mobile</h3>
		<p>Settings → Connectors → <em>Add custom connector</em>, name it <code>memory-go</code> and paste the URL above. It then works on every device you use Claude on.</p>
		<h3>ChatGPT</h3><p>Settings → Apps &amp; Connectors → <em>Create</em> (developer mode), paste the URL above and choose OAuth.</p>
		<h3>Claude Code</h3><pre class="box">claude mcp add --transport http --scope user memory-go ${escape(mcp)}</pre><p>Then run <code>/mcp</code> in Claude Code to sign in.</p>
		<h3>Codex</h3><pre class="box">[mcp_servers.memory-go]\nurl = "${escape(mcp)}"</pre><p>in <code>~/.codex/config.toml</code>, then <code>codex mcp login memory-go</code>.</p>
		<h3>Local, offline-capable sync on your laptops</h3>
		<p>The <a href="https://github.com/dunkbing/memory-go">memory-go CLI</a> keeps a git clone of a workspace on your machine and serves it to local agents, syncing with this server:</p>
		<pre class="box">go install github.com/dunkbing/memory-go@latest\nmemory-go setup --cloud ${escape(c.env.PUBLIC_URL)}</pre>
		<h3>Plain git</h3><p>Each workspace is a git repository. Its settings page shows how to clone it.</p>`,
	);
});

// ---- notes -------------------------------------------------------------------

web.get("/w/:slug", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const { user, ws, all } = ctx;
	const stub = workspaceStub(c.env, ws);
	const q = { text: c.req.query("q") ?? "", tag: c.req.query("tag") ?? "", category: c.req.query("category") ?? "", since: c.req.query("since") ?? "" };
	const filtering = q.text || q.tag || q.category || q.since;
	let results = "";
	let error = "";
	if (filtering) {
		try {
			const hits = await stub.search({ text: q.text, tags: q.tag ? [q.tag] : [], category: q.category, since: parseWhen(q.since, Date.now()), limit: 50 });
			results = hits.length
				? `<ul class="hits">${hits
						.map(
							(h) => `<li><a href="${noteHref(ws, h.path)}"><strong>${escape(h.title)}</strong></a>${h.pinned ? '<span class="badge">pinned</span>' : ""}
					<div class="meta">${escape(h.path)} · ${day(h.updated)} ${h.tags.map((t) => `<a class="tag" href="/w/${ws.slug}?tag=${encodeURIComponent(t)}">#${escape(t)}</a>`).join(" ")}</div>
					${h.observations?.length ? `<ul>${h.observations.map((o) => `<li>${escape(o)}</li>`).join("")}</ul>` : `<div class="snip">${escape(h.snippet || h.summary).replace(/\*\*([^*]+)\*\*/g, "<mark>$1</mark>")}</div>`}</li>`,
						)
						.join("")}</ul>`
				: `<p class="muted">No notes match.</p>`;
		} catch (e) {
			error = errMessage(e);
		}
	} else {
		const notes = await stub.list("");
		if (!notes.length) {
			results = `<div class="card"><p><strong>No notes yet.</strong> Connect an AI app (see <a href="/connect">Connect</a>) and it will save what it learns here, or <a href="/w/${ws.slug}/new">write one</a>, or <a href="/w/${ws.slug}/import">import your Claude or ChatGPT history</a>.</p></div>`;
		} else {
			const pinned = notes.filter((n) => n.pinned);
			const groups = new Map<string, typeof notes>();
			for (const n of notes) {
				const dir = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "(top level)";
				groups.set(dir, [...(groups.get(dir) ?? []), n]);
			}
			const item = (h: (typeof notes)[0]) =>
				`<li><a href="${noteHref(ws, h.path)}">${escape(h.title)}</a> <span class="muted">${day(h.updated)}${h.summary ? " · " + escape(h.summary.slice(0, 120)) : ""}</span></li>`;
			results =
				(pinned.length ? `<h3>Pinned</h3><ul class="hits">${pinned.map(item).join("")}</ul>` : "") +
				[...groups]
					.map(([dir, ns]) => `<details open><summary>${escape(dir)} (${ns.length})</summary><ul class="hits">${ns.map(item).join("")}</ul></details>`)
					.join("");
		}
	}
	return page(
		{ title: ws.name, user, workspaces: all, current: ws, active: "notes", error },
		`<div class="row" style="justify-content:space-between"><h1 style="margin:0">${escape(ws.name)}</h1><a class="btn" href="/w/${ws.slug}/new">New note</a></div>
		<form class="row" style="margin:16px 0" method="get">
			<input type="search" name="q" value="${escape(q.text)}" placeholder="Search notes" style="flex:1;min-width:200px">
			<input type="text" name="tag" value="${escape(q.tag)}" placeholder="tag" size="10">
			<input type="text" name="category" value="${escape(q.category)}" placeholder="category, e.g. decision" size="18">
			<input type="text" name="since" value="${escape(q.since)}" placeholder="since: 30d" size="9">
			<button type="submit">Search</button>${filtering ? `<a class="btn plain" href="/w/${ws.slug}">Clear</a>` : ""}
		</form>${results}`,
	);
});

web.get("/w/:slug/n/*", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const { user, ws, all } = ctx;
	const path = decodeURIComponent(new URL(c.req.url).pathname.slice(`/w/${ws.slug}/n/`.length));
	const stub = workspaceStub(c.env, ws);
	let note;
	try {
		note = await stub.readNote(path);
	} catch (e) {
		return notFound(c, user, errMessage(e));
	}
	const n = parse(note.path, note.content);
	const graph = await stub.graph();
	const titles = new Map(graph.nodes.map((g) => [g.path, g]));
	const bySlug = new Map<string, string>();
	for (const g of graph.nodes) {
		bySlug.set(linkTarget(g.path.slice(g.path.lastIndexOf("/") + 1)).slug, g.path);
		bySlug.set(linkTarget(g.title).slug, g.path);
	}
	const resolve = (target: string) => {
		const t = linkTarget(target);
		const p = t.notePath ? (titles.has(t.notePath) ? t.notePath : null) : (bySlug.get(t.slug) ?? null);
		return p ? noteHref(ws, p) : null;
	};
	const out = graph.edges.filter((e) => e.from === note.path).map((e) => e.to);
	const linkList = (paths: string[]) => (paths.length ? `<ul>${[...new Set(paths)].map((p) => `<li><a href="${noteHref(ws, p)}">${escape(titles.get(p)?.title ?? p)}</a></li>`).join("")}</ul>` : `<p class="muted">None</p>`);
	const flash = c.req.query("flash");
	return page(
		{ title: n.title, user, workspaces: all, current: ws, active: "notes", flash },
		`<div class="cols"><article class="note"><h1>${escape(n.title)}${n.pinned ? '<span class="badge">pinned</span>' : ""}${n.locked ? '<span class="badge">locked</span>' : ""}</h1>
		<div class="muted">${escape(note.path)} · updated ${day(note.updated)}${n.created ? ` · created ${escape(n.created.slice(0, 10))}` : ""}
		${n.tags.map((t) => ` <a class="tag" href="/w/${ws.slug}?tag=${encodeURIComponent(t)}">#${escape(t)}</a>`).join("")}</div>
		<div class="body">${renderMarkdown(n.body, resolve)}</div></article>
		<aside class="side"><div class="row"><a class="btn" href="/w/${ws.slug}/edit/${enc(note.path)}">Edit</a>
		<form class="inline" method="post" action="/w/${ws.slug}/pin/${enc(note.path)}"><input type="hidden" name="pinned" value="${n.pinned ? "0" : "1"}"><button class="plain">${n.pinned ? "Unpin" : "Pin"}</button></form></div>
		<h3>Links to</h3>${linkList(out)}<h3>Linked from</h3>${linkList(note.backlinks.map((b) => b.path))}
		<h3>Move or rename</h3><form method="post" action="/w/${ws.slug}/move/${enc(note.path)}">
		<p><input type="text" name="directory" value="${escape(note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : "")}" placeholder="directory" style="width:100%"></p>
		<p><input type="text" name="title" value="${escape(n.title)}" style="width:100%"></p><button class="plain">Move</button></form>
		<h3>Delete</h3><form method="post" action="/w/${ws.slug}/delete/${enc(note.path)}" onsubmit="return this.confirm.checked"><label><input type="checkbox" name="confirm"> I'm sure</label> <button class="danger">Delete</button></form>
		<p class="muted">Git history keeps deleted notes.</p></aside></div>`,
	);
});

web.get("/w/:slug/new", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	return newNotePage(c, ctx, {});
});

function newNotePage(c: C, ctx: { user: User; ws: Workspace; all: Workspace[] }, v: { title?: string; directory?: string; tags?: string; content?: string }, error?: string) {
	const { user, ws, all } = ctx;
	return page(
		{ title: "New note", user, workspaces: all, current: ws, active: "notes", error },
		`<h1>New note</h1><form method="post"><div class="row"><input type="text" name="title" value="${escape(v.title ?? "")}" placeholder="Title" required style="flex:1">
		<input type="text" name="directory" value="${escape(v.directory ?? c.req.query("directory") ?? "")}" placeholder="directory, e.g. general"><input type="text" name="tags" value="${escape(v.tags ?? "")}" placeholder="tags, comma separated"></div>
		<p><textarea name="content" placeholder="- [decision] …  #tag   Link notes with [[Title]]">${escape(v.content ?? "")}</textarea></p><button>Create</button></form>`,
	);
}

web.post("/w/:slug/new", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const f = await c.req.parseBody();
	const v = { title: String(f.title ?? ""), directory: String(f.directory ?? ""), tags: String(f.tags ?? ""), content: String(f.content ?? "") };
	try {
		const r = await workspaceStub(c.env, ctx.ws).write({ title: v.title, directory: v.directory, content: v.content, tags: v.tags.split(",").map((t) => t.trim()).filter(Boolean) }, actorOf(ctx.user));
		return c.redirect(noteHref(ctx.ws, r.path));
	} catch (e) {
		return newNotePage(c, ctx, v, errMessage(e));
	}
});

web.get("/w/:slug/edit/*", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const path = decodeURIComponent(new URL(c.req.url).pathname.slice(`/w/${ctx.ws.slug}/edit/`.length));
	try {
		const note = await workspaceStub(c.env, ctx.ws).readNote(path);
		return editPage(ctx, note.path, note.content);
	} catch (e) {
		return notFound(c, ctx.user, errMessage(e));
	}
});

function editPage(ctx: { user: User; ws: Workspace; all: Workspace[] }, path: string, content: string, error?: string) {
	return page(
		{ title: `Edit ${path}`, user: ctx.user, workspaces: ctx.all, current: ctx.ws, active: "notes", error },
		`<h1>Edit</h1><p class="muted">${escape(path)}: the whole file, including its frontmatter (title, tags, pinned, locked).</p>
		<form method="post"><p><textarea name="content">${escape(content)}</textarea></p><div class="row"><button>Save</button><a class="btn plain" href="${noteHref(ctx.ws, path)}">Cancel</a></div></form>`,
	);
}

web.post("/w/:slug/edit/*", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const path = decodeURIComponent(new URL(c.req.url).pathname.slice(`/w/${ctx.ws.slug}/edit/`.length));
	const content = String((await c.req.parseBody()).content ?? "");
	try {
		await workspaceStub(c.env, ctx.ws).put(path, content, actorOf(ctx.user), false);
		return c.redirect(noteHref(ctx.ws, path) + "?flash=Saved");
	} catch (e) {
		return editPage(ctx, path, content, errMessage(e));
	}
});

const notePathAction = (c: C, ws: Workspace, action: string) => decodeURIComponent(new URL(c.req.url).pathname.slice(`/w/${ws.slug}/${action}/`.length));

web.post("/w/:slug/pin/*", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const path = notePathAction(c, ctx.ws, "pin");
	const pinned = String((await c.req.parseBody()).pinned) === "1";
	try {
		await workspaceStub(c.env, ctx.ws).pin(path, pinned, actorOf(ctx.user));
		return c.redirect(noteHref(ctx.ws, path) + `?flash=${pinned ? "Pinned: shown in full at the start of every session" : "Unpinned"}`);
	} catch (e) {
		return c.redirect(noteHref(ctx.ws, path) + `?flash=${encodeURIComponent(errMessage(e))}`);
	}
});

web.post("/w/:slug/move/*", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const path = notePathAction(c, ctx.ws, "move");
	const f = await c.req.parseBody();
	try {
		const r = await workspaceStub(c.env, ctx.ws).move(path, String(f.directory ?? ""), String(f.title ?? ""), actorOf(ctx.user));
		return c.redirect(noteHref(ctx.ws, r.path) + `?flash=${encodeURIComponent(`Moved${r.updated.length ? `; updated links in ${r.updated.length} note(s)` : ""}`)}`);
	} catch (e) {
		return c.redirect(noteHref(ctx.ws, path) + `?flash=${encodeURIComponent(errMessage(e))}`);
	}
});

web.post("/w/:slug/delete/*", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const path = notePathAction(c, ctx.ws, "delete");
	if (!(await c.req.parseBody()).confirm) return c.redirect(noteHref(ctx.ws, path));
	try {
		await workspaceStub(c.env, ctx.ws).delete(path, actorOf(ctx.user));
		return c.redirect(`/w/${ctx.ws.slug}`);
	} catch (e) {
		return c.redirect(noteHref(ctx.ws, path) + `?flash=${encodeURIComponent(errMessage(e))}`);
	}
});

// ---- graph, history, import, export -------------------------------------------

web.get("/w/:slug/graph.json", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	return c.json(await workspaceStub(c.env, ctx.ws).graph());
});

web.get("/w/:slug/graph", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const { user, ws, all } = ctx;
	return page(
		{ title: "Graph", user, workspaces: all, current: ws, active: "graph" },
		`<h1>Link graph</h1><p class="muted">Notes and the [[links]] between them. Click a note to open it; drag to rearrange.</p>
		<div class="card" style="padding:0;overflow:hidden"><canvas id="g" style="width:100%;height:70vh;display:block;touch-action:none"></canvas></div>
		<script>${GRAPH_SCRIPT.replace("__SLUG__", JSON.stringify(ws.slug))}</script>`,
	);
});

// A dependency-free force layout: repulsion between all notes, springs along
// links, drawn on a canvas in the page's theme colors.
const GRAPH_SCRIPT = `
(async () => {
const slug = __SLUG__;
const data = await (await fetch('/w/' + slug + '/graph.json')).json();
const cv = document.getElementById('g'), ctx = cv.getContext('2d');
const css = getComputedStyle(document.documentElement);
const color = (v) => css.getPropertyValue(v).trim();
const nodes = data.nodes.map((n, i) => ({ ...n, x: Math.cos(i) * 200 * Math.random(), y: Math.sin(i) * 200 * Math.random(), vx: 0, vy: 0 }));
const byPath = new Map(nodes.map((n) => [n.path, n]));
const edges = data.edges.map((e) => [byPath.get(e.from), byPath.get(e.to)]).filter(([a, b]) => a && b);
const degree = new Map(); for (const [a, b] of edges) { degree.set(a, (degree.get(a) || 0) + 1); degree.set(b, (degree.get(b) || 0) + 1); }
let scale = 1, ox = 0, oy = 0, drag = null, hover = null;
function resize() { const r = cv.getBoundingClientRect(); cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio; }
resize(); addEventListener('resize', resize);
function step() {
	for (const a of nodes) for (const b of nodes) { if (a === b) continue; const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01; const f = 900 / d2; a.vx += dx * f; a.vy += dy * f; }
	for (const [a, b] of edges) { const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = (d - 90) * 0.01; a.vx += dx / d * f * d * 0.05; a.vy += dy / d * f * d * 0.05; b.vx -= dx / d * f * d * 0.05; b.vy -= dy / d * f * d * 0.05; }
	for (const n of nodes) { n.vx -= n.x * 0.002; n.vy -= n.y * 0.002; if (n !== drag) { n.x += n.vx * 0.5; n.y += n.vy * 0.5; } n.vx *= 0.6; n.vy *= 0.6; }
}
const toScreen = (n) => [cv.width / 2 + (n.x + ox) * scale * devicePixelRatio, cv.height / 2 + (n.y + oy) * scale * devicePixelRatio];
function draw() {
	ctx.clearRect(0, 0, cv.width, cv.height);
	ctx.strokeStyle = color('--line'); ctx.lineWidth = devicePixelRatio;
	for (const [a, b] of edges) { const [x1, y1] = toScreen(a), [x2, y2] = toScreen(b); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
	ctx.font = (12 * devicePixelRatio) + 'px system-ui'; ctx.textAlign = 'center';
	for (const n of nodes) { const [x, y] = toScreen(n), r = (4 + Math.min(8, (degree.get(n) || 0) * 1.5)) * devicePixelRatio;
		ctx.fillStyle = n.pinned ? color('--warn') : color('--accent'); ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
		if (n === hover || (degree.get(n) || 0) > 2 || nodes.length < 40) { ctx.fillStyle = color('--fg'); ctx.fillText(n.title, x, y - r - 4 * devicePixelRatio); } }
}
function pick(e) { const r = cv.getBoundingClientRect(); const px = (e.clientX - r.left) * devicePixelRatio, py = (e.clientY - r.top) * devicePixelRatio;
	let best = null, bd = 400 * devicePixelRatio; for (const n of nodes) { const [x, y] = toScreen(n); const d = (x - px) ** 2 + (y - py) ** 2; if (d < bd) { bd = d; best = n; } } return best; }
let moved = false;
cv.addEventListener('pointerdown', (e) => { drag = pick(e); moved = false; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointermove', (e) => { if (drag) { moved = true; drag.x += e.movementX / scale; drag.y += e.movementY / scale; } else hover = pick(e); });
cv.addEventListener('pointerup', () => { if (drag && !moved) location.href = '/w/' + slug + '/n/' + drag.path.split('/').map(encodeURIComponent).join('/'); drag = null; });
cv.addEventListener('wheel', (e) => { e.preventDefault(); scale *= e.deltaY < 0 ? 1.1 : 0.9; }, { passive: false });
(function loop() { step(); draw(); requestAnimationFrame(loop); })();
if (!nodes.length) { ctx.fillStyle = color('--muted'); ctx.font = (14 * devicePixelRatio) + 'px system-ui'; ctx.fillText('No notes yet', cv.width / 2, cv.height / 2); }
})();`;

web.get("/w/:slug/history", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const { user, ws, all } = ctx;
	const log = await workspaceStub(c.env, ws).history(50);
	const rows = log
		.map(
			(e) => `<tr><td class="muted">${new Date(e.time).toISOString().replace("T", " ").slice(0, 16)}</td><td>${escape(e.message)}<div class="muted">${escape(e.author)}</div></td>
			<td>${e.files.filter((f) => f.endsWith(".md")).map((f) => `<a href="${noteHref(ws, f)}">${escape(permalink(f))}</a>`).join("<br>")}</td></tr>`,
		)
		.join("");
	return page(
		{ title: "History", user, workspaces: all, current: ws, active: "history" },
		`<h1>History</h1><p class="muted">Every change, from any app or machine, is a git commit. The last 50:</p>
		<div class="wrap"><table><tr><th>When</th><th>Change</th><th>Notes</th></tr>${rows || `<tr><td colspan="3" class="muted">No changes yet.</td></tr>`}</table></div>`,
	);
});

web.get("/w/:slug/import", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	return importPage(ctx);
});

function importPage(ctx: { user: User; ws: Workspace; all: Workspace[] }, flash?: string, error?: string) {
	return page(
		{ title: "Import", user: ctx.user, workspaces: ctx.all, current: ctx.ws, active: "import", flash, error },
		`<h1>Import</h1><div class="card"><form method="post" enctype="multipart/form-data">
		<p>Upload one of:</p><ul>
		<li><strong>Claude</strong>: claude.ai → Settings → Privacy → <em>Export data</em>; upload the zip you receive.</li>
		<li><strong>ChatGPT</strong>: Settings → Data controls → <em>Export data</em>; upload the zip.</li>
		<li><strong>Markdown notes</strong>: a zip of a folder (Basic Memory, Obsidian, memory-go). Paths are kept.</li></ul>
		<p><input type="file" name="file" accept=".zip,.json" required></p><button>Import</button></form>
		<p class="muted">Conversations become searchable notes under <code>imports/claude/</code> or <code>imports/chatgpt/</code>, one per conversation, in a single commit.
		Existing notes are never overwritten. Ask an agent to read imported conversations and save the lasting facts as regular notes.</p></div>`,
	);
}

web.post("/w/:slug/import", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const file = (await c.req.parseBody()).file;
	if (!(file instanceof File)) return importPage(ctx, undefined, "Choose a file to import.");
	try {
		const parsed = parseExport(file.name, new Uint8Array(await file.arrayBuffer()));
		if (!parsed.files.length) return importPage(ctx, undefined, "Nothing to import in that file.");
		const r = await workspaceStub(c.env, ctx.ws).importFiles(parsed.files, actorOf(ctx.user), `import ${parsed.files.length} notes from ${parsed.source}`);
		return importPage(ctx, `Imported ${r.written.length} note(s) from ${parsed.source}${r.skipped.length ? `; skipped ${r.skipped.length} that already existed` : ""}.`);
	} catch (e) {
		return importPage(ctx, undefined, `Import failed: ${errMessage(e)}`);
	}
});

web.get("/w/:slug/export.zip", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const files = await workspaceStub(c.env, ctx.ws).files();
	const zip = zipSync(Object.fromEntries(files.map((f) => [`${ctx.ws.slug}/${f.path}`, strToU8(f.content)])));
	return new Response(zip, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${ctx.ws.slug}-notes.zip"` } });
});

// ---- workspaces and teams -----------------------------------------------------

web.get("/w/:slug/settings", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	return settingsPage(c, ctx);
});

async function settingsPage(c: C, ctx: { user: User; ws: Workspace; all: Workspace[] }, flash?: string, error?: string) {
	const { user, ws, all } = ctx;
	const list = await members(c.env, ws.id);
	const stats = await workspaceStub(c.env, ws).stats();
	const manage = canManage(ws);
	const memberRows = list
		.map(
			(m) => `<tr><td>${escape(m.login)}${m.name ? ` <span class="muted">${escape(m.name)}</span>` : ""}</td><td>${m.role}</td>
			<td>${m.role !== "owner" && (manage || m.user_id === user.id) ? `<form class="inline" method="post" action="/w/${ws.slug}/members/${m.user_id}/remove"><button class="plain">${m.user_id === user.id ? "Leave" : "Remove"}</button></form>` : ""}</td></tr>`,
		)
		.join("");
	return page(
		{ title: "Settings", user, workspaces: all, current: ws, active: "settings", flash, error },
		`<h1>${escape(ws.name)}</h1><p class="muted">${ws.kind === "team" ? "Team workspace" : "Personal workspace"} · your role: ${ws.role} · ${stats.notes} notes · slug <code>${escape(ws.slug)}</code> (agents pass it as <code>workspace</code>)</p>
		<div class="cols"><div>
		${ws.kind === "team" ? `<h2>Members</h2><div class="wrap"><table>${memberRows}</table></div>
		${manage ? `<form method="post" action="/w/${ws.slug}/invites" class="row" style="margin-top:12px"><select name="role"><option value="member">member</option><option value="admin">admin</option></select><button>Create invite link</button></form><p class="muted">Links work once and expire after 7 days.</p>` : ""}` : `<h2>Teams</h2><p>Share a memory with other people and their agents in a team workspace.</p>`}
		<h2>New team workspace</h2><form method="post" action="/teams" class="row"><input type="text" name="name" placeholder="Team name" required><button>Create team</button></form>
		</div><div><h2>Your data</h2><p><a class="btn plain" href="/w/${ws.slug}/export.zip">Download all notes (zip)</a></p>
		<p class="muted">Clone it with git: run <code>memory-go setup --cloud ${escape(c.env.PUBLIC_URL)} --workspace ${escape(ws.slug)}</code>, which keeps a synced clone in <code>~/.memory-go</code>.</p></div></div>`,
	);
}

web.post("/teams", async (c) => {
	const user = requireUser(c);
	if (user instanceof Response) return user;
	const name = String((await c.req.parseBody()).name ?? "").trim();
	if (!name) return c.redirect("/");
	const ws = await createWorkspace(c.env, user, name, "team");
	return c.redirect(`/w/${ws.slug}/settings`);
});

web.post("/w/:slug/invites", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	const role = String((await c.req.parseBody()).role) === "admin" ? "admin" : "member";
	try {
		const code = await createInvite(c.env, ctx.ws, ctx.user, role);
		return settingsPage(c, ctx, `Invite link (as ${role}): ${c.env.PUBLIC_URL}/invite/${code}`);
	} catch (e) {
		return settingsPage(c, ctx, undefined, errMessage(e));
	}
});

web.post("/w/:slug/members/:userId/remove", async (c) => {
	const ctx = await loadWorkspace(c);
	if (ctx instanceof Response) return ctx;
	try {
		await removeMember(c.env, ctx.ws, ctx.user, c.req.param("userId"));
		if (c.req.param("userId") === ctx.user.id) return c.redirect("/");
		return settingsPage(c, ctx, "Removed.");
	} catch (e) {
		return settingsPage(c, ctx, undefined, errMessage(e));
	}
});

web.get("/invite/:code", async (c) => {
	const user = requireUser(c);
	if (user instanceof Response) return user;
	const inv = await invite(c.env, c.req.param("code"));
	if (!inv) return page({ title: "Invite", user, error: "This invite link is invalid or has expired." }, "");
	return page(
		{ title: "Invite", user },
		`<div class="hero card"><h1>Join ${escape(inv.name)}?</h1><p>You'll join as <strong>${inv.role}</strong>, and your AI apps will be able to read and write this team's notes.</p>
		<form method="post"><button>Join team</button></form></div>`,
	);
});

web.post("/invite/:code", async (c) => {
	const user = requireUser(c);
	if (user instanceof Response) return user;
	try {
		return c.redirect(`/w/${await acceptInvite(c.env, c.req.param("code"), user)}`);
	} catch (e) {
		return page({ title: "Invite", user, error: errMessage(e) }, "");
	}
});

web.notFound((c) => notFound(c, c.get("user") ?? null, "This page doesn't exist."));
