// The web app: sign-in, the OAuth consent page for MCP clients, and pages to
// browse, search, edit, import and share notes.

import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { strToU8, zipSync } from "fflate";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
	type User,
	acceptInvite,
	createSession,
	endSession,
	invite,
	sessionUser,
	signIn,
	workspaceFor,
	workspacesFor,
	workspaceStub,
} from "../accounts";
import { SESSION, appApi } from "./api";
import { escape, page } from "./layout";

type Env_ = { Bindings: Env; Variables: { user: User | null } };
type C = Context<Env_>;

export const web = new Hono<Env_>();


const STATE = "mg_login";
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

const notFound = (c: C, user: User | null, message: string) => {
	const r = page({ title: "Not found", user }, `<h1>Not found</h1><p>${escape(message)}</p>`);
	return new Response(r.body, { status: 404, headers: r.headers });
};

// ---- sign-in -----------------------------------------------------------------

const safeNext = (next: string | undefined) => (next && next.startsWith("/") && !next.startsWith("//") ? next : "/app");

// GitHub endpoints, overridable for tests.
const githubWeb = (env: Env) => env.GITHUB_WEB_URL ?? "https://github.com";
const githubApi = (env: Env) => env.GITHUB_API_URL ?? "https://api.github.com";

async function githubUser(env: Env, token: string) {
	const res = await fetch(`${githubApi(env)}/user`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "gitmind-cloud" },
	});
	if (!res.ok) throw new Error(`Couldn't read your GitHub profile (${res.status}).`);
	return (await res.json()) as { id: number; login: string; name?: string; avatar_url?: string };
}

web.get("/login", async (c) => {
	if (c.env.DEV_LOGIN === "1" && c.req.query("dev")) return c.redirect(`/dev/login?login=${encodeURIComponent(c.req.query("dev")!)}&next=${encodeURIComponent(c.req.query("next") ?? "/")}`);
	if (!c.env.GITHUB_CLIENT_SECRET) return deviceLogin(c);
	const state = crypto.randomUUID();
	setCookie(c, STATE, `${state}|${safeNext(c.req.query("next"))}`, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
	const u = new URL(`${githubWeb(c.env)}/login/oauth/authorize`);
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
	const tokenRes = await fetch(`${githubWeb(c.env)}/login/oauth/access_token`, {
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
	try {
		return finishSignIn(c, await signIn(c.env, await githubUser(c.env, token.access_token)), next);
	} catch (e) {
		return page({ title: "Sign-in failed", error: errMessage(e) }, "");
	}
});

// Without a client secret (GITHUB_CLIENT_SECRET unset), sign-in uses GitHub's
// device flow, which needs only the OAuth App's public client ID: the page
// shows a code, the user approves it on github.com, and the page polls until
// GitHub confirms. Self-hosters can then sign in with gitmind's public app
// and skip creating their own.
const DEVICE_LOGIN = "gitmind-login:";

async function deviceLogin(c: C) {
	const res = await fetch(`${githubWeb(c.env)}/login/device/code`, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: c.env.GITHUB_CLIENT_ID, scope: "read:user" }),
	});
	const dc = (await res.json()) as { device_code?: string; user_code?: string; verification_uri?: string; interval?: number; expires_in?: number };
	if (!dc.device_code) return page({ title: "Sign-in unavailable", error: `GitHub didn't start a sign-in (${res.status}). Is device flow enabled for the OAuth App?` }, "");
	const id = crypto.randomUUID();
	await c.env.OAUTH_KV.put(DEVICE_LOGIN + id, JSON.stringify({ device: dc.device_code, next: safeNext(c.req.query("next")), interval: dc.interval ?? 5 }), {
		expirationTtl: Math.max(60, dc.expires_in ?? 900),
	});
	const out = page(
		{ title: "Sign in with GitHub" },
		`<div class="hero card"><h1>Sign in with GitHub</h1>
		<p>Enter this code on GitHub to confirm it's you:</p>
		<p style="font:600 30px ui-monospace,monospace;letter-spacing:.08em;margin:8px 0">${escape(dc.user_code!)}</p>
		<p><a class="btn" href="${escape(dc.verification_uri!)}" target="_blank" rel="noopener">Open GitHub</a></p>
		<p class="muted" id="status">Waiting for you to approve gitmind on GitHub…</p></div>
		<script>
		(async () => {
			const status = document.getElementById("status");
			for (;;) {
				await new Promise((r) => setTimeout(r, ${(dc.interval ?? 5) * 1000}));
				const res = await fetch("/login/poll", { method: "POST" });
				const r = await res.json();
				if (r.done) { location.href = r.next; return; }
				if (r.error) { status.textContent = r.error; return; }
			}
		})();
		</script>`,
	);
	// Bind the pending sign-in to this browser, so a leaked poll id is useless.
	// (Set on the response itself: page() doesn't go through Hono's context.)
	out.headers.append("Set-Cookie", `${STATE}=${id}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax`);
	return out;
}

web.post("/login/poll", async (c) => {
	const id = getCookie(c, STATE);
	const pending = id ? await c.env.OAUTH_KV.get<{ device: string; next: string }>(DEVICE_LOGIN + id, "json") : null;
	if (!id || !pending) return c.json({ error: "This sign-in expired. Reload the page to start again." });
	const res = await fetch(`${githubWeb(c.env)}/login/oauth/access_token`, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: c.env.GITHUB_CLIENT_ID, device_code: pending.device, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
	});
	const t = (await res.json()) as { access_token?: string; error?: string };
	if (t.error === "authorization_pending" || t.error === "slow_down") return c.json({ pending: true });
	await c.env.OAUTH_KV.delete(DEVICE_LOGIN + id);
	deleteCookie(c, STATE, { path: "/", secure: true });
	if (!t.access_token) return c.json({ error: t.error === "access_denied" ? "Sign-in was denied on GitHub." : `GitHub sign-in failed (${t.error ?? res.status}). Reload to try again.` });
	try {
		const user = await signIn(c.env, await githubUser(c.env, t.access_token));
		setCookie(c, SESSION, await createSession(c.env, user.id), { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 30 * 86400 });
		return c.json({ done: true, next: pending.next });
	} catch (e) {
		return c.json({ error: errMessage(e) });
	}
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
			${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it, e.g. with <code>gitmind setup</code>.</p>" : ""}
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
		// The app's name goes with every change it makes (provenance).
		const client = await oauth.describeConsent(approved.request).then((d) => d.clientName, () => undefined);
		const { redirectTo } = await oauth.completeAuthorization({
			request: approved.request,
			userId: user.id,
			metadata: { login: user.login },
			scope: approved.request.scope,
			props: { userId: user.id, client },
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

// ---- the app ---------------------------------------------------------------

web.route("/api/app", appApi);

// The static site serves "/"; this only runs without built assets (tests).
web.get("/", (c) => c.redirect("/app"));

// /app opens the signed-in user's personal workspace.
web.get("/app", async (c) => {
	const user = requireUser(c);
	if (user instanceof Response) return user;
	const ws = await workspaceFor(c.env, user.id);
	return c.redirect(ws ? `/w/${ws.slug}` : "/connect");
});

web.get("/w/:slug/export.zip", async (c) => {
	const user = requireUser(c);
	if (user instanceof Response) return user;
	const ws = (await workspacesFor(c.env, user.id)).find((w) => w.slug === c.req.param("slug"));
	if (!ws) return notFound(c, user, "No such workspace, or you're not a member.");
	const files = await workspaceStub(c.env, ws).files();
	const zip = zipSync(Object.fromEntries(files.map((f) => [`${ws.slug}/${f.path}`, strToU8(f.content)])));
	return new Response(zip, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${ws.slug}-notes.zip"` } });
});

// Everything else in the app is the single-page app (cloud/app), which
// routes on the client and talks to /api/app.
const appShell = async (c: C) => {
	const user = requireUser(c);
	if (user instanceof Response) return user;
	// "/_app/", not "/_app/index.html", which the asset server redirects.
	const built = c.env.ASSETS ? await c.env.ASSETS.fetch(new URL("/_app/", c.req.url)) : null;
	const html = built?.ok ? await built.text() : `<!doctype html><html><head><meta charset="utf-8"><title>gitmind</title></head><body><div id="root"></div></body></html>`;
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-cache",
			"Content-Security-Policy": "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "same-origin",
		},
	});
};
web.get("/connect", appShell);
web.get("/w/:slug", appShell);
web.get("/w/:slug/*", appShell);

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
