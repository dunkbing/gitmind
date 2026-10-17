// Users, workspaces, members and invites, stored in D1.

import { slugify } from "./engine/notes";

export interface User {
	id: string;
	github_id: number;
	login: string;
	name: string | null;
	avatar_url: string | null;
}

export type Role = "owner" | "admin" | "member";

export interface Workspace {
	id: string;
	slug: string;
	name: string;
	kind: "personal" | "team";
	repo: string;
	role: Role;
}

export interface Member {
	user_id: string;
	login: string;
	name: string | null;
	avatar_url: string | null;
	role: Role;
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

export function workspaceStub(env: Env, ws: { id: string }) {
	const ns = env.WORKSPACE as unknown as DurableObjectNamespace<import("./workspace/workspace").Workspace>;
	return ns.get(ns.idFromName(ws.id));
}

// signIn records a GitHub user, creating their account and personal
// workspace on first sign-in.
export async function signIn(env: Env, gh: { id: number; login: string; name?: string | null; avatar_url?: string | null }): Promise<User> {
	const existing = await env.DB.prepare(`SELECT * FROM users WHERE github_id = ?`).bind(gh.id).first<User>();
	if (existing) {
		await env.DB.prepare(`UPDATE users SET login = ?, name = ?, avatar_url = ? WHERE id = ?`)
			.bind(gh.login, gh.name ?? null, gh.avatar_url ?? null, existing.id)
			.run();
		return { ...existing, login: gh.login, name: gh.name ?? null, avatar_url: gh.avatar_url ?? null };
	}
	const user: User = { id: newId(), github_id: gh.id, login: gh.login, name: gh.name ?? null, avatar_url: gh.avatar_url ?? null };
	await env.DB.prepare(`INSERT INTO users (id, github_id, login, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind(user.id, user.github_id, user.login, user.name, user.avatar_url, Date.now())
		.run();
	await createWorkspace(env, user, gh.login, "personal");
	return user;
}

export async function getUser(env: Env, id: string): Promise<User | null> {
	return env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<User>();
}

// createWorkspace makes a workspace with the creator as owner, and its
// repository.
export async function createWorkspace(env: Env, owner: User, name: string, kind: "personal" | "team"): Promise<Workspace> {
	const id = newId();
	const base = slugify(name).slice(0, 40);
	let slug = base;
	for (let i = 2; await env.DB.prepare(`SELECT 1 FROM workspaces WHERE slug = ?`).bind(slug).first(); i++) slug = `${base}-${i}`;
	const ws: Workspace = { id, slug, name, kind, repo: `ws-${id}`, role: "owner" };
	const now = Date.now();
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO workspaces (id, slug, name, kind, repo, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, slug, name, kind, ws.repo, owner.id, now),
		env.DB.prepare(`INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`).bind(id, owner.id, now),
	]);
	await workspaceStub(env, ws).configure(ws.repo);
	return ws;
}

export async function workspacesFor(env: Env, userId: string): Promise<Workspace[]> {
	const { results } = await env.DB.prepare(
		`SELECT w.id, w.slug, w.name, w.kind, w.repo, m.role FROM workspaces w JOIN members m ON m.workspace_id = w.id
		 WHERE m.user_id = ? ORDER BY w.kind = 'team', w.name`,
	)
		.bind(userId)
		.all<Workspace>();
	return results;
}

// workspaceFor returns the user's workspace by slug, or their personal
// workspace when slug is empty; null when they aren't a member.
export async function workspaceFor(env: Env, userId: string, slug?: string): Promise<Workspace | null> {
	const all = await workspacesFor(env, userId);
	if (!slug) return all.find((w) => w.kind === "personal") ?? all[0] ?? null;
	return all.find((w) => w.slug === slug.toLowerCase()) ?? null;
}

export const canManage = (ws: Workspace) => ws.role === "owner" || ws.role === "admin";

export async function members(env: Env, workspaceId: string): Promise<Member[]> {
	const { results } = await env.DB.prepare(
		`SELECT u.id AS user_id, u.login, u.name, u.avatar_url, m.role FROM members m JOIN users u ON u.id = m.user_id
		 WHERE m.workspace_id = ? ORDER BY m.role = 'member', u.login`,
	)
		.bind(workspaceId)
		.all<Member>();
	return results;
}

export async function createInvite(env: Env, ws: Workspace, by: User, role: "admin" | "member"): Promise<string> {
	if (ws.kind !== "team") throw new Error("only team workspaces can have members");
	if (!canManage(ws)) throw new Error("only owners and admins can invite");
	const bytes = crypto.getRandomValues(new Uint8Array(18));
	const code = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]!);
	const now = Date.now();
	await env.DB.prepare(`INSERT INTO invites (code, workspace_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind(code, ws.id, role, by.id, now, now + 7 * 86_400_000)
		.run();
	return code;
}

export async function invite(env: Env, code: string): Promise<{ workspace_id: string; name: string; slug: string; role: Role } | null> {
	return env.DB.prepare(
		`SELECT i.workspace_id, w.name, w.slug, i.role FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.code = ? AND i.expires_at > ?`,
	)
		.bind(code, Date.now())
		.first();
}

export async function acceptInvite(env: Env, code: string, user: User): Promise<string> {
	const inv = await invite(env, code);
	if (!inv) throw new Error("this invite link is invalid or has expired");
	await env.DB.batch([
		env.DB.prepare(`INSERT OR IGNORE INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`).bind(inv.workspace_id, user.id, inv.role, Date.now()),
		env.DB.prepare(`DELETE FROM invites WHERE code = ?`).bind(code),
	]);
	return inv.slug;
}

export async function removeMember(env: Env, ws: Workspace, by: User, userId: string): Promise<void> {
	if (!canManage(ws) && userId !== by.id) throw new Error("only owners and admins can remove members");
	const target = await env.DB.prepare(`SELECT role FROM members WHERE workspace_id = ? AND user_id = ?`).bind(ws.id, userId).first<{ role: Role }>();
	if (!target) return;
	if (target.role === "owner") throw new Error("the owner can't be removed");
	await env.DB.prepare(`DELETE FROM members WHERE workspace_id = ? AND user_id = ?`).bind(ws.id, userId).run();
}

// Web sessions.

const sha256 = async (s: string) =>
	[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function createSession(env: Env, userId: string): Promise<string> {
	const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
	const now = Date.now();
	await env.DB.prepare(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
		.bind(await sha256(token), userId, now, now + 30 * 86_400_000)
		.run();
	return token;
}

export async function sessionUser(env: Env, token: string | undefined): Promise<User | null> {
	if (!token) return null;
	return env.DB.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`)
		.bind(await sha256(token), Date.now())
		.first<User>();
}

export async function endSession(env: Env, token: string | undefined): Promise<void> {
	if (token) await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(await sha256(token)).run();
}
