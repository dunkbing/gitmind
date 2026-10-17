// Test helpers: a cookie-keeping browser, an OAuth client that signs in the
// way MCP clients do (registration, PKCE, consent), and MCP calls.

import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export const BASE = "https://memory.test";

export class Browser {
	private jar = new Map<string, string>();

	async fetch(url: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		if (this.jar.size) headers.set("Cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
		if (init.method === "POST" && !headers.has("Origin")) headers.set("Origin", BASE);
		const res = await SELF.fetch(url.startsWith("http") ? url : BASE + url, { ...init, headers, redirect: "manual" });
		for (const c of res.headers.getSetCookie()) {
			const [pair, ...attrs] = c.split(";");
			const i = pair.indexOf("=");
			const name = pair.slice(0, i).trim();
			if (attrs.some((a) => /max-age=0/i.test(a))) this.jar.delete(name);
			else this.jar.set(name, pair.slice(i + 1).trim());
		}
		return res;
	}

	post(url: string, form: Record<string, string>) {
		return this.fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
	}
}

export async function signedIn(login: string): Promise<Browser> {
	const b = new Browser();
	const res = await b.fetch(`/dev/login?login=${login}&next=/`);
	expect(res.status).toBe(302);
	return b;
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// connect signs `browser`'s user in to a new OAuth client and returns its
// tokens, as claude.ai or the CLI would.
export async function connect(browser: Browser, opts: { clientName?: string } = {}): Promise<{ token: string; refresh?: string; client_id: string }> {
	const r = await authorize(browser, true, opts.clientName);
	if (!("token" in r)) throw new Error(`authorization failed: ${r.error}`);
	return r;
}

// deny runs the same flow but clicks Deny, returning the error the client gets.
export async function deny(browser: Browser): Promise<string | null> {
	const r = await authorize(browser, false);
	return "error" in r ? r.error : null;
}

async function authorize(browser: Browser, approve: boolean, clientName?: string): Promise<{ token: string; refresh?: string; client_id: string } | { error: string | null }> {
	const opts = { approve, clientName };
	const redirect = "http://127.0.0.1:9999/callback";
	const reg = await SELF.fetch(`${BASE}/oauth/register`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: opts.clientName ?? "Test MCP client",
			redirect_uris: [redirect],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
		}),
	});
	expect(reg.status).toBe(201);
	const { client_id } = (await reg.json()) as { client_id: string };
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	const auth = new URL(`${BASE}/authorize`);
	for (const [k, v] of Object.entries({
		response_type: "code", client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256",
		state: "st4te", scope: "memory offline_access", resource: `${BASE}/mcp`,
	})) auth.searchParams.set(k, v);

	const consent = await browser.fetch(auth.toString());
	expect(consent.status).toBe(200);
	const html = await consent.text();
	expect(html).toContain(opts.clientName ?? "Test MCP client");
	const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
	const decided = await browser.post("/authorize", { handle, decision: opts.approve === false ? "deny" : "approve" });
	expect(decided.status).toBe(302);
	const back = new URL(decided.headers.get("Location")!);
	expect(back.origin + back.pathname).toBe(redirect);
	expect(back.searchParams.get("state")).toBe("st4te");
	if (opts.approve === false) return { error: back.searchParams.get("error") };

	const tok = await SELF.fetch(`${BASE}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: redirect,
			client_id, code_verifier: verifier, resource: `${BASE}/mcp`,
		}).toString(),
	});
	expect(tok.status).toBe(200);
	const t = (await tok.json()) as { access_token: string; refresh_token?: string };
	return { token: t.access_token, refresh: t.refresh_token, client_id };
}

let rpcId = 0;

// tool calls an MCP tool and returns its text and whether it was an error.
export async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
	const res = await SELF.fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: {
			Host: "memory.test",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
	});
	const body = await res.text();
	expect(res.status, body).toBe(200);
	const json = body.startsWith("{") ? JSON.parse(body) : JSON.parse(body.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
	if (json.error) return { text: json.error.message, isError: true };
	return { text: json.result.content.map((c: { text: string }) => c.text).join("\n"), isError: !!json.result.isError };
}

export async function listTools(token: string): Promise<string[]> {
	const res = await SELF.fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { Host: "memory.test", Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }),
	});
	const body = await res.text();
	const json = body.startsWith("{") ? JSON.parse(body) : JSON.parse(body.split("\n").find((l) => l.startsWith("data:"))!.slice(5));
	return json.result.tools.map((t: { name: string }) => t.name).sort();
}
