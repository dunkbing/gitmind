// The remote MCP endpoint: the same tools as the CLI's local server
// (internal/server in Go), plus workspace selection for teams.

import { McpServer } from "@modelcontextprotocol/server";
import { env as workerEnv } from "cloudflare:workers";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { type User, getUser, workspaceFor, workspacesFor, workspaceStub } from "./accounts";
import { cleanDir } from "./engine/notes";
import type { Hit, Query } from "./workspace/store";
import type { Conflict } from "./workspace/workspace";

export interface AuthProps {
	userId: string;
	// The app the user connected (its OAuth client name), for provenance.
	// Logins from before it was recorded don't have it.
	client?: string;
}

const INSTRUCTIONS = `Persistent memory shared across the user's machines and AI apps, stored as Markdown notes in a git repository.
Search it before starting work on a topic; save what a future session would otherwise have to rediscover when you finish.
Save only durable facts that make sense on their own, outside this conversation. Prefer saving nothing over saving noise.
A suggestion is not a decision until the user confirms it; your own output only counts once the user adopts it.
Skip one-off requests, routine steps, and anything already in the code or git history. Never store secrets.
Write facts as "- [category] fact #tag" with categories such as decision, preference, instruction (standing rules
like "from now on..."), gotcha, anti-pattern, setup, task (with status), artifact (with a link).
When a fact changes, replace it with edit_note's supersede operation, which keeps the old version under "## History" with
the date, rather than silently overwriting it. When a save reports possibly conflicting facts, supersede the outdated one.
Prefer editing an existing note over creating a near-duplicate. Notes marked locked are the user's.
When you stop with work unfinished, leave a handoff for the next session (in any app): where it stands, what failed, what's next.
Every tool works on the user's personal workspace unless you pass workspace (see list_workspaces).`;

const workspaceArg = z.string().optional().describe("workspace slug from list_workspaces; omit for the personal workspace");

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

export function mcpHandler(version: string, hostname: string) {
	return createMcpHandler(() => createServer(version), {
		route: "/mcp",
		// Custom domains need explicit Host and Origin policies; requests
		// without an Origin (non-browser clients) are always allowed.
		allowedHostnames: [hostname],
		allowedOriginHostnames: [hostname, "claude.ai", "chatgpt.com"],
	});
}

function createServer(version: string): McpServer {
	const server = new McpServer({ name: "gitmind", version }, { instructions: INSTRUCTIONS });

	const ctx = async (env: Env, slug?: string) => {
		const props = getMcpAuthContext()?.props as AuthProps | undefined;
		if (!props?.userId) throw new Error("not signed in");
		const user = await getUser(env, props.userId);
		if (!user) throw new Error("account not found");
		const ws = await workspaceFor(env, user.id, slug);
		if (!ws) throw new Error(slug ? `no workspace "${slug}" (see list_workspaces)` : "no workspace");
		return { user, ws, stub: workspaceStub(env, ws), actor: { ...actorOf(user), source: props.client || "an AI app", agent: true } };
	};
	const env = () => workerEnv as Env;

	server.registerTool(
		"list_workspaces",
		{ description: "List the workspaces you can use: your personal one and any teams." },
		async () => {
			const props = getMcpAuthContext()?.props as AuthProps | undefined;
			const all = await workspacesFor(env(), props!.userId);
			return text(all.map((w) => `- ${w.slug} (${w.kind}, ${w.role})${w.kind === "personal" ? " [default]" : ""}: ${w.name}`).join("\n"));
		},
	);

	server.registerTool(
		"search_notes",
		{
			description:
				"Search memory notes by meaning and keywords together: a query finds notes that say the same thing in other words " +
				"(or another language) as well as notes containing its words. Combine with filters by directory, tags, observation " +
				"category and update date. With filters only, the newest matches come first.",
			inputSchema: {
				query: z.string().optional().describe("words to look for in titles, tags and bodies; may be omitted when filtering"),
				directory: z.string().optional().describe("only notes under this directory, e.g. a project name"),
				tags: z.array(z.string()).optional().describe("only notes with all of these tags (frontmatter tags or inline #tags)"),
				category: z.string().optional().describe("only notes with observations in this category, e.g. decision or gotcha; the matching lines are shown"),
				since: z.string().optional().describe("only notes updated on or after this date (YYYY-MM-DD) or within this period (e.g. 7d, 2w, 3m, 1y)"),
				before: z.string().optional().describe("only notes last updated before this date (YYYY-MM-DD)"),
				limit: z.number().int().optional().describe("maximum number of results (default 10)"),
				mode: z.enum(["hybrid", "keyword", "semantic"]).optional().describe("hybrid (default): meaning and keywords; keyword: exact words only; semantic: meaning only"),
				include_history: z.boolean().optional().describe("also match facts kept under History headings (replaced or removed ones), e.g. to find why something changed; notes matched only there come last, marked [history]"),
				workspace: workspaceArg,
			},
		},
		async (a) => {
			const { stub } = await ctx(env(), a.workspace);
			const q = { ...toQuery(a, Date.now()), mode: a.mode, includeHistory: a.include_history };
			return text(formatHits("No notes match.", await stub.search(q)));
		},
	);

	server.registerTool(
		"read_note",
		{ description: "Read a memory note in full, with the notes linking to it.", inputSchema: { identifier: z.string().describe("note path, permalink or exact title"), workspace: workspaceArg } },
		async (a) => {
			const { stub } = await ctx(env(), a.workspace);
			const r = await stub.readNote(a.identifier);
			let out = `path: ${r.path}\nmodified: ${new Date(r.updated).toISOString()}\n\n${r.content}`;
			if (r.backlinks.length) out += `\nLinked from: ${r.backlinks.map((b) => `[[${b.title}]]`).join(", ")}\n`;
			return text(out);
		},
	);

	server.registerTool(
		"build_context",
		{
			description:
				"Read a note together with its neighbourhood: the notes it links to, the notes linking to it (with a one-line summary of each), " +
				"and links to notes not written yet. Use it to follow a topic across notes.",
			inputSchema: {
				identifier: z.string().describe("note path, permalink or exact title"),
				depth: z.number().int().optional().describe("1 for direct links (default), 2 to also list notes two links away"),
				workspace: workspaceArg,
			},
		},
		async (a) => {
			const { stub } = await ctx(env(), a.workspace);
			return text(await stub.buildContext(a.identifier, a.depth ?? 1));
		},
	);

	server.registerTool(
		"project_context",
		{
			description:
				"Load what memory knows about a project: the user's profile (standing instructions and preferences), pinned notes in full, " +
				"and an index of the project's notes, general notes and recent activity. Call it at the start of a session.",
			inputSchema: {
				project: z.string().optional().describe("project name, e.g. the git repository's directory name; omit for general notes only"),
				budget: z.number().int().optional().describe("rough size limit in characters (default 12000, at most 30000)"),
				workspace: workspaceArg,
			},
		},
		async (a) => {
			const { stub } = await ctx(env(), a.workspace);
			return text(await stub.projectContext(a.project ?? "", Math.min(a.budget && a.budget > 0 ? a.budget : 12000, 30000)));
		},
	);

	server.registerTool(
		"write_note",
		{
			description:
				"Create a memory note. Fails if a note with the same title already exists in that directory, unless overwrite is true; " +
				"to add to an existing note, use edit_note instead.",
			inputSchema: {
				title: z.string().describe("note title; also determines the file name"),
				directory: z.string().optional().describe("folder for the note, e.g. the project name or 'general'"),
				content: z.string().describe("Markdown body. Write facts as '- [category] fact #tag' and link notes with [[Title]]"),
				tags: z.array(z.string()).optional().describe("tags for the note; kept from the existing note when omitted"),
				overwrite: z.boolean().optional().describe("replace the content of an existing note with the same title and directory (default false)"),
				pinned: z.boolean().optional().describe("show this note in full at the start of every session; only for things the user wants always remembered"),
				workspace: workspaceArg,
			},
		},
		async (a) => {
			const { stub, actor } = await ctx(env(), a.workspace);
			const r = await stub.write({ title: a.title, directory: a.directory, content: a.content, tags: a.tags, overwrite: a.overwrite, pinned: a.pinned }, actor);
			let msg = `${r.created ? "Created" : "Updated"} ${r.path}` + conflictsText(r.conflicts);
			if (r.similar.length) {
				msg += "\n\nPossibly overlapping notes. If the new note duplicates one of them, merge it in with edit_note and delete the new one:\n" + formatHits("", r.similar);
			}
			return text(msg);
		},
	);

	server.registerTool(
		"edit_note",
		{
			description:
				"Edit a memory note in place: append, prepend, find_replace text, replace_section to rewrite everything under one heading " +
				"(added at the end if the heading doesn't exist), or supersede a fact that changed: the new fact takes its place and the old one " +
				"moves under the note's History heading with today's date.",
			inputSchema: {
				identifier: z.string().describe("note path, permalink or exact title"),
				operation: z.enum(["append", "prepend", "find_replace", "replace_section", "supersede"]),
				content: z.string().describe("text to add; the replacement for find_replace; the new content under the heading for replace_section; the new fact for supersede (empty to retire the old one)"),
				find_text: z.string().optional().describe("find_replace: text to replace; supersede: the current fact to replace, e.g. '[decision] use bge-m3' (list marker, case and trailing #tags don't matter)"),
				expected_replacements: z.number().int().optional().describe("fail unless find_text occurs exactly this many times"),
				section: z.string().optional().describe("heading whose content to replace (replace_section only); its subsections are replaced too"),
				workspace: workspaceArg,
			},
		},
		async (a) => {
			const { stub, actor } = await ctx(env(), a.workspace);
			const r = await stub.edit(
				{ identifier: a.identifier, operation: a.operation, content: a.content, findText: a.find_text, expectedReplacements: a.expected_replacements, section: a.section },
				actor,
			);
			let msg = `Edited ${r.path}`;
			if (r.addedSection) msg = `Edited ${r.path}: no section "${a.section}" existed, so it was added at the end`;
			else if (a.operation === "supersede") msg += a.content.trim() ? ": the new fact replaced the old one, which moved to History" : ": the fact moved to History";
			return text(msg + conflictsText(r.conflicts));
		},
	);

	server.registerTool(
		"handoff",
		{
			description:
				"Leave a handoff for the next session in this project, whichever app or agent it runs in: where the work stands, what failed, " +
				"what's next. It replaces the previous handoff, and the next session sees it at the start. Call it when you stop with work " +
				"unfinished; clear it (empty content) when the work is done.",
			inputSchema: {
				project: z.string().describe("project name: the git repository's directory name"),
				content: z.string().describe("a few lines: what you were doing, what failed or is undecided, the next steps; empty to clear the handoff once the work is done"),
				workspace: workspaceArg,
			},
		},
		async (a) => {
			const { stub, actor } = await ctx(env(), a.workspace);
			const path = await stub.handoff(a.project, a.content, actor);
			if (a.content.trim()) return text(`Saved the handoff in ${path}`);
			return text(path ? `Cleared the handoff (${path})` : "There was no handoff to clear");
		},
	);

	server.registerTool(
		"move_note",
		{
			description: "Move a note to another directory and/or give it a new title (which renames the file). Links to it in other notes are updated so they keep working.",
			inputSchema: {
				identifier: z.string().describe("note path, permalink or exact title"),
				directory: z.string().optional().describe('new directory; omit to keep the current one, "" for the top level'),
				title: z.string().optional().describe("new title, which also renames the file; omit to keep it"),
				workspace: workspaceArg,
			},
		},
		async (a) => {
			if (a.directory === undefined && !a.title?.trim()) throw new Error("give a new directory, a new title, or both");
			const { stub, actor } = await ctx(env(), a.workspace);
			const r = await stub.move(a.identifier, a.directory, a.title, actor);
			return text(`Moved to ${r.path}${r.updated.length ? "; updated links in " + r.updated.join(", ") : ""}`);
		},
	);

	server.registerTool(
		"pin_note",
		{
			description:
				"Pin a note so it's shown in full at the start of every session (or unpin it). Use sparingly, for things the user wants always remembered.",
			inputSchema: { identifier: z.string().describe("note path, permalink or exact title"), unpin: z.boolean().optional().describe("remove the pin instead"), workspace: workspaceArg },
		},
		async (a) => {
			const { stub, actor } = await ctx(env(), a.workspace);
			const path = await stub.pin(a.identifier, !a.unpin, actor);
			return text(`${a.unpin ? "Unpinned" : "Pinned"} ${path}`);
		},
	);

	server.registerTool(
		"delete_note",
		{ description: "Delete a memory note. Git history keeps the old content.", inputSchema: { identifier: z.string().describe("note path, permalink or exact title"), workspace: workspaceArg } },
		async (a) => {
			const { stub, actor } = await ctx(env(), a.workspace);
			return text(`Deleted ${await stub.delete(a.identifier, actor)}`);
		},
	);

	server.registerTool(
		"recent_activity",
		{ description: "List the most recently changed memory notes, newest first. Useful when resuming work.", inputSchema: { limit: z.number().int().optional(), workspace: workspaceArg } },
		async (a) => {
			const { stub } = await ctx(env(), a.workspace);
			return text(formatHits("Memory is empty.", await stub.recent(clamp(a.limit, 10))));
		},
	);

	server.registerTool(
		"list_notes",
		{ description: "List memory notes by path, optionally under one directory.", inputSchema: { directory: z.string().optional(), workspace: workspaceArg } },
		async (a) => {
			const { stub } = await ctx(env(), a.workspace);
			return text(formatHits("No notes found.", await stub.list(a.directory ?? "")));
		},
	);

	return server;
}

export const actorOf = (user: User) => ({ login: user.login, name: user.name ?? undefined });

const clamp = (n: number | undefined, def: number) => (!n || n <= 0 ? def : Math.min(n, 100));

export function toQuery(
	a: { query?: string; directory?: string; tags?: string[]; category?: string; since?: string; before?: string; limit?: number },
	now: number,
): Query {
	const q: Query = { text: a.query, dir: cleanDir(a.directory ?? ""), tags: a.tags, category: a.category, limit: clamp(a.limit, 10) };
	try {
		q.since = parseWhen(a.since, now);
		q.before = parseWhen(a.before, now);
	} catch (e) {
		throw new Error(`${(e as Error).message}`);
	}
	if (!q.text?.trim() && !q.dir && !q.tags?.length && !q.category && !q.since && !q.before) {
		throw new Error("give a query or at least one filter (directory, tags, category, since, before)");
	}
	return q;
}

// parseWhen accepts a date (2026-10-01), an ISO time, or a period back from
// now: 7d, 2w, 3m or 1y. It returns ms since epoch, or undefined.
export function parseWhen(s: string | undefined, now: number): number | undefined {
	s = s?.trim();
	if (!s) return undefined;
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + "T00:00:00Z");
	if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s))) return Date.parse(s);
	const m = /^(\d+)([dwmy])$/.exec(s);
	if (m) {
		const n = Number(m[1]);
		const d = new Date(now);
		if (m[2] === "d") d.setUTCDate(d.getUTCDate() - n);
		if (m[2] === "w") d.setUTCDate(d.getUTCDate() - 7 * n);
		if (m[2] === "m") d.setUTCMonth(d.getUTCMonth() - n);
		if (m[2] === "y") d.setUTCFullYear(d.getUTCFullYear() - n);
		return d.getTime();
	}
	throw new Error(`"${s}" is not a date (YYYY-MM-DD) or period (7d, 2w, 3m, 1y)`);
}

// conflictsText lists current facts that may conflict with facts just saved,
// for the agent to supersede if they're outdated.
export function conflictsText(conflicts: Conflict[]): string {
	if (!conflicts.length) return "";
	let b =
		"\n\nPossibly conflicting facts. If an existing one is outdated, supersede it with edit_note " +
		'(operation "supersede", find_text: the old fact); if it says the same thing, remove the duplicate. If they don\'t conflict, ignore this.\n';
	for (const c of conflicts) {
		b += `- new: [${c.fact.category}] ${c.fact.text}\n  existing in ${c.with.path}: [${c.with.category}] ${c.with.text}${c.same ? " (same wording)" : ""}\n`;
	}
	return b.replace(/\n+$/, "");
}

export function formatHits(empty: string, hits: Hit[]): string {
	if (!hits.length) return empty;
	let b = "";
	for (const h of hits) {
		b += `- ${h.title} (${h.path}, modified ${new Date(h.updated).toISOString().slice(0, 10)})`;
		if (h.pinned) b += " [pinned]";
		if (h.history) b += " [history]";
		if (h.tags.length) b += ` #${h.tags.join(" #")}`;
		b += "\n";
		if (h.observations?.length) for (const o of h.observations) b += `  - ${o}\n`;
		else if (h.snippet) b += `  ${h.snippet.split(/\s+/).join(" ")}\n`;
		else if (h.summary) b += `  ${h.summary}\n`;
	}
	return b;
}
