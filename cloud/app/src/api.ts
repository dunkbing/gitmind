// The Worker's JSON API (cloud/src/web/api.ts).

export interface User {
	id: string;
	login: string;
	name: string | null;
	avatar_url: string | null;
}

export interface Workspace {
	id: string;
	slug: string;
	name: string;
	kind: "personal" | "team";
	role: "owner" | "admin" | "member";
}

export interface Me {
	user: User;
	workspaces: Workspace[];
	mcpUrl: string;
	setupCommand: string;
}

export interface Hit {
	path: string;
	title: string;
	tags: string[];
	updated: number;
	summary: string;
	pinned: boolean;
	snippet: string;
	observations?: string[];
}

export interface NoteData {
	path: string;
	content: string;
	updated: number;
	hash: string;
	backlinks: { title: string; path: string }[];
}

export interface Graph {
	nodes: { path: string; title: string; pinned: boolean }[];
	edges: { from: string; to: string }[];
}

export interface Commit {
	oid: string;
	message: string;
	author: string;
	time: number;
	files: string[];
}

export interface Member {
	user_id: string;
	login: string;
	name: string | null;
	role: string;
}

export interface Settings {
	stats: { notes: number; head: string | null; passages: number; embedded: number; model: string | null };
	members: Member[];
	canManage: boolean;
	setupCommand: string;
}

export interface InboxItem {
	id: number;
	path: string;
	before: string | null; // null: the app created the note
	after: string | null; // null: the app deleted it
	source: string;
	actor: string;
	created: number;
	updated: number;
	conflicts: FactConflict[]; // current facts that may conflict with what it added
}

export interface FactConflict {
	fact: { category: string; text: string }; // added by the change
	with: { path: string; title: string; category: string; text: string }; // already in memory
	same: boolean; // exactly the same wording
}

export interface ReviewSettings {
	enabled: boolean;
	trusted: string[];
}

export interface ProfileFact {
	category: "instruction" | "preference";
	text: string;
	title: string;
	path: string;
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: Record<string, unknown>,
	) {
		super(message);
	}
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
	const init: RequestInit = { method, headers: { "X-Gitmind": "1" }, credentials: "same-origin" };
	if (body instanceof FormData) init.body = body;
	else if (body !== undefined) {
		init.body = JSON.stringify(body);
		(init.headers as Record<string, string>)["Content-Type"] = "application/json";
	}
	const res = await fetch("/api/app" + url, init);
	if (res.status === 401) {
		location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
		throw new ApiError("Signed out", 401, {});
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status, data);
	return data as T;
}

const w = (slug: string) => `/w/${encodeURIComponent(slug)}`;
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

export const api = {
	me: () => call<Me>("GET", "/me"),
	notes: (slug: string) => call<Hit[]>("GET", `${w(slug)}/notes`),
	note: (slug: string, path: string) => call<NoteData>("GET", `${w(slug)}/note?${qs({ path })}`),
	save: (slug: string, path: string, content: string, base: string) => call<NoteData>("PUT", `${w(slug)}/note`, { path, content, base }),
	create: (slug: string, title: string, directory: string, content = "", tags: string[] = []) =>
		call<{ path: string }>("POST", `${w(slug)}/notes`, { title, directory, content, tags }),
	move: (slug: string, path: string, directory: string | undefined, title: string | undefined) =>
		call<{ path: string; updated: string[] }>("POST", `${w(slug)}/move`, { path, directory, title }),
	pin: (slug: string, path: string, pinned: boolean) => call<{ path: string }>("POST", `${w(slug)}/pin`, { path, pinned }),
	remove: (slug: string, path: string) => call<{ path: string }>("DELETE", `${w(slug)}/note?${qs({ path })}`),
	search: (slug: string, q: { q?: string; tag?: string; category?: string; since?: string; limit?: number; mode?: "hybrid" | "keyword" | "semantic" }) =>
		call<Hit[]>("GET", `${w(slug)}/search?${qs(Object.fromEntries(Object.entries(q).filter(([, v]) => v).map(([k, v]) => [k, String(v)])))}`),
	related: (slug: string, path: string) => call<Hit[]>("GET", `${w(slug)}/related?${qs({ path })}`),
	inbox: (slug: string) => call<{ items: InboxItem[]; settings: ReviewSettings; sources: string[] }>("GET", `${w(slug)}/inbox`),
	inboxCount: (slug: string) => call<{ count: number }>("GET", `${w(slug)}/inbox/count`),
	accept: (slug: string, ids: number[] | "all") => call<{ ok: true }>("POST", `${w(slug)}/inbox/accept`, ids === "all" ? { all: true } : { ids }),
	supersede: (slug: string, path: string, fact: string, replacement = "") => call<{ path: string }>("POST", `${w(slug)}/supersede`, { path, fact, replacement }),
	reject: (slug: string, id: number, reason?: string) => call<{ path: string }>("POST", `${w(slug)}/inbox/${id}/reject`, { reason }),
	setReview: (slug: string, settings: ReviewSettings) => call<ReviewSettings>("PUT", `${w(slug)}/review`, settings),
	profile: (slug: string) => call<ProfileFact[]>("GET", `${w(slug)}/profile`),
	graph: (slug: string) => call<Graph>("GET", `${w(slug)}/graph`),
	history: (slug: string) => call<Commit[]>("GET", `${w(slug)}/history`),
	importFile: (slug: string, file: File) => {
		const f = new FormData();
		f.set("file", file);
		return call<{ source: string; written: string[]; skipped: string[] }>("POST", `${w(slug)}/import`, f);
	},
	settings: (slug: string) => call<Settings>("GET", `${w(slug)}/settings`),
	createTeam: (name: string) => call<Workspace>("POST", "/teams", { name }),
	invite: (slug: string, role: string) => call<{ url: string; role: string }>("POST", `${w(slug)}/invites`, { role }),
	removeMember: (slug: string, userId: string) => call<{ ok: true }>("POST", `${w(slug)}/members/${encodeURIComponent(userId)}/remove`),
};
