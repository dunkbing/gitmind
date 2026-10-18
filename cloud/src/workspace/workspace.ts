// One Durable Object per workspace. It owns the workspace's search index and
// is the only writer of its git repository from the cloud side; laptops push
// to the same repository with plain git. A port of internal/memory (Go).

import { DurableObject } from "cloudflare:workers";
import {
	type Note,
	cleanDir,
	format,
	linkTarget,
	normalizeTags,
	nowRFC3339,
	parse,
	permalink,
	replaceSection,
	rewriteLinks,
	slugify,
	validPath,
} from "../engine/notes";
import { checkSecrets } from "../engine/secrets";
import { ConflictError, type FileChange, Session } from "../repo/git";
import { remoteFor, repoProvider } from "../repo/provider";
import { type ProfileFact, buildContext, profile, sessionContext } from "./context";
import { type Embedder, embedderFor } from "./embed";
import { type Hit, type InboxItem, type Query, Store } from "./store";

export interface Actor {
	login: string;
	name?: string;
	// Where the change comes from, for commit messages and the inbox: an AI
	// app's name (e.g. "claude.ai"), or "web" for the web app.
	source?: string;
	// An AI app acting for the user: its changes go to the inbox for review.
	agent?: boolean;
}

export interface ReviewSettings {
	enabled: boolean; // agents' changes go to the inbox
	trusted: string[]; // sources whose changes skip it
}

// How a write affects the inbox: an agent's change is recorded for review;
// the user's own change to a note counts as reviewing it; a move keeps any
// pending review (moved with the note).
type InboxEffect = "record" | "resolve" | "keep";

export interface WriteArgs {
	title: string;
	directory?: string;
	content: string;
	tags?: string[];
	overwrite?: boolean;
	pinned?: boolean;
}

export interface EditArgs {
	identifier: string;
	operation: "append" | "prepend" | "find_replace" | "replace_section";
	content: string;
	findText?: string;
	expectedReplacements?: number;
	section?: string;
}

export interface WriteResult {
	path: string;
	created: boolean;
	similar: Hit[];
}

// The note that collects reasons for rejected changes.
const FEEDBACK = "general/memory-feedback.md";

// Files every workspace repository starts with, matching the CLI's init.
const INIT_FILES: FileChange[] = [
	{ path: ".gitattributes", content: "*.md merge=union\n" },
	{ path: ".gitignore", content: ".gitmind/\n" },
];

// How long reads trust the index before checking the repository for pushes
// from elsewhere (e.g. a laptop). FRESHNESS_MS in the environment overrides
// it (tests set 0).
const FRESHNESS_MS = 2_000;

export class Workspace extends DurableObject<Env> {
	private store: Store;
	private session: Session | null = null;
	private lastCheck = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private embedder: Embedder | null;
	private queryVectors = new Map<string, Float32Array>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.store = new Store(ctx.storage.sql);
		this.embedder = embedderFor(env);
		// A different model's vectors can't be compared: embed again.
		if (this.embedder && this.store.meta("embed_model") !== this.embedder.id) {
			this.store.clearVectors();
			this.store.setMeta("embed_model", this.embedder.id);
		}
	}

	// configure binds this object to its repository, creating the repository
	// with the standard files if needed. Safe to call again.
	async configure(repoName: string): Promise<void> {
		await this.serialize(async () => {
			this.store.setMeta("repo", repoName);
			await repoProvider(this.env).create(repoName);
			const s = await this.openSession();
			const missing = INIT_FILES.filter((f) => !s.blobs.has(f.path));
			if (missing.length) await s.commit(missing, "gitmind: init", { name: "gitmind", email: "cloud@gitmind" });
			await this.syncIndex(s);
		});
	}

	// ---- reads -------------------------------------------------------------

	async search(q: Query): Promise<Hit[]> {
		await this.fresh();
		const query = { ...q, dir: q.dir ? cleanDir(q.dir) : "" };
		const vec = q.text?.trim() && q.mode !== "keyword" ? await this.queryVector(q.text.trim()) : null;
		return this.store.search(query, vec ?? undefined);
	}

	// related lists the notes closest in meaning to a note.
	async related(id: string, limit: number): Promise<Hit[]> {
		await this.fresh();
		if (!this.embedder) return [];
		return this.store.related(this.resolve(id), limit, this.embedder.minScore + 0.1);
	}

	// queryVector embeds a search query, or returns null when semantic
	// search isn't available (no embedder, nothing embedded yet, or the
	// model failing), so search falls back to keywords.
	private async queryVector(text: string): Promise<{ vec: Float32Array; minScore: number } | null> {
		if (!this.embedder || !this.store.hasVectors()) return null;
		let vec = this.queryVectors.get(text);
		if (!vec) {
			try {
				[vec] = await this.embedder.embed([text], "query");
			} catch (e) {
				console.error("query embedding failed, searching by keyword", e);
				return null;
			}
			if (this.queryVectors.size > 200) this.queryVectors.clear();
			this.queryVectors.set(text, vec);
		}
		return { vec, minScore: this.embedder.minScore };
	}

	// alarm embeds passages that don't have vectors yet, in batches, after
	// notes change. It runs in the background so writes never wait on it.
	async alarm(): Promise<void> {
		if (!this.embedder) return;
		const deadline = Date.now() + 60_000;
		let done = 0;
		while (Date.now() < deadline) {
			const batch = this.store.pendingChunks(32);
			if (!batch.length) {
				if (done) console.log(`embedded ${done} passages with ${this.embedder.id}`);
				return;
			}
			let vecs: Float32Array[];
			try {
				vecs = await this.embedder.embed(batch.map((c) => c.text), "document");
			} catch (e) {
				console.error("embedding failed; retrying in a minute", e);
				await this.ctx.storage.setAlarm(Date.now() + 60_000);
				return;
			}
			this.store.setVectors(batch.map((c, i) => ({ id: c.id, hash: c.hash, vec: vecs[i] })));
			done += batch.length;
		}
		console.log(`embedded ${done} passages, continuing`);
		await this.ctx.storage.setAlarm(Date.now() + 1000);
	}

	// embedLater schedules the alarm when there's something to embed.
	private async embedLater() {
		if (!this.embedder) return;
		const pending = this.store.pendingCount();
		if (pending === 0) return;
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + 500);
			console.log(`${pending} passages to embed; scheduled`);
		}
	}

	async readNote(id: string): Promise<{ path: string; content: string; updated: number; backlinks: { title: string; path: string }[] }> {
		await this.fresh();
		const path = this.resolve(id);
		const r = this.store.read(path)!;
		return { path, content: r.content, updated: r.updated, backlinks: this.store.backlinks(path).map((h) => ({ title: h.title, path: h.path })) };
	}

	async recent(limit: number): Promise<Hit[]> {
		await this.fresh();
		return this.store.recent(limit);
	}

	async list(dir: string): Promise<Hit[]> {
		await this.fresh();
		return this.store.list(cleanDir(dir));
	}

	async buildContext(id: string, depth: number): Promise<string> {
		await this.fresh();
		return buildContext(this.store, this.resolve(id), depth);
	}

	async projectContext(project: string, budget: number): Promise<string> {
		await this.fresh();
		return sessionContext(this.store, cleanDir(project), budget);
	}

	// profile lists the user's standing instructions and preferences, for
	// the web app (agents get them through projectContext).
	async profile(project: string): Promise<ProfileFact[]> {
		await this.fresh();
		return profile(this.store, project ? cleanDir(project) : "");
	}

	async stats(): Promise<{ notes: number; head: string | null; passages: number; embedded: number; model: string | null }> {
		await this.fresh();
		const { passages, embedded } = this.store.embeddingStats();
		return { notes: this.store.count(), head: this.store.meta("head") || null, passages, embedded, model: this.embedder?.id ?? null };
	}

	// files returns every note's content, for export.
	async files(): Promise<{ path: string; content: string }[]> {
		await this.fresh();
		return this.store.list("").map((h) => ({ path: h.path, content: this.store.read(h.path)!.content }));
	}

	// ---- writes ------------------------------------------------------------

	async write(a: WriteArgs, actor: Actor): Promise<WriteResult> {
		const title = a.title.trim().normalize("NFC");
		if (!title) throw new Error("title is required");
		checkSecrets(title, a.content, (a.tags ?? []).join(" "));
		const dir = cleanDir(a.directory ?? "");
		const path = (dir ? dir + "/" : "") + slugify(title) + ".md";
		const result = await this.mutate(actor, () => {
			const old = this.store.read(path);
			const n: Note = {
				path, title, tags: normalizeTags(a.tags ?? []), created: nowRFC3339(),
				pinned: !!a.pinned, locked: false, extra: [], body: a.content,
			};
			if (old) {
				if (!a.overwrite) {
					throw new Error(`note ${path} already exists (titled "${old.note.title}"); add to it with edit_note, or call write_note with overwrite=true to replace its content`);
				}
				if (old.note.locked) throw lockedError(path);
				n.created = old.note.created;
				n.extra = old.note.extra;
				n.pinned = old.note.pinned || !!a.pinned;
				if (!a.tags?.length) n.tags = old.note.tags;
			}
			return { changes: [{ path, content: format(n) }], message: `${old ? "update" : "add"} ${path}`, result: !old };
		});
		const n = this.store.read(path)!.note;
		return { path, created: result, similar: result ? this.store.similar(path, n.title, n.tags, 3) : [] };
	}

	async edit(a: EditArgs, actor: Actor): Promise<{ path: string; addedSection: boolean }> {
		checkSecrets(a.content, a.section ?? "");
		return this.mutate(actor, () => {
			const path = this.resolve(a.identifier);
			const n = this.store.read(path)!.note;
			if (n.locked) throw lockedError(path);
			let addedSection = false;
			switch (a.operation) {
				case "append":
					n.body = n.body.replace(/\n+$/, "") + separator(n.body, a.content) + a.content.replace(/^\n+/, "");
					break;
				case "prepend":
					n.body = a.content.replace(/\n+$/, "") + "\n\n" + n.body.replace(/^\n+/, "");
					break;
				case "find_replace": {
					if (!a.findText) throw new Error("find_text is required for find_replace");
					const count = n.body.split(a.findText).length - 1;
					if (count === 0) throw new Error(`find_text not found in ${path}`);
					if (a.expectedReplacements && count !== a.expectedReplacements) {
						throw new Error(`find_text occurs ${count} times in ${path}, expected ${a.expectedReplacements}`);
					}
					n.body = n.body.split(a.findText).join(a.content);
					break;
				}
				case "replace_section": {
					const r = replaceSection(n.body, a.section ?? "", a.content);
					n.body = r.body;
					addedSection = r.added;
					break;
				}
				default:
					throw new Error(`unknown operation "${a.operation}" (use append, prepend, find_replace or replace_section)`);
			}
			return { changes: [{ path, content: format(n) }], message: `edit ${path}`, result: { path, addedSection } };
		});
	}

	async delete(id: string, actor: Actor): Promise<string> {
		return this.mutate(actor, () => {
			const path = this.resolve(id);
			if (this.store.read(path)!.note.locked) throw lockedError(path);
			return { changes: [{ path, content: null }], message: `delete ${path}`, result: path };
		});
	}

	async pin(id: string, pinned: boolean, actor: Actor): Promise<string> {
		return this.mutate(actor, () => {
			const path = this.resolve(id);
			const n = this.store.read(path)!.note;
			if (n.locked) throw lockedError(path);
			if (n.pinned === pinned) return { changes: [], message: "", result: path };
			n.pinned = pinned;
			return { changes: [{ path, content: format(n) }], message: `${pinned ? "pin" : "unpin"} ${path}`, result: path };
		});
	}

	// move gives a note a new directory (undefined keeps it) and/or title.
	// As in the CLI, the file is renamed in a commit of its own with unchanged
	// content so git records a rename, then a second commit updates the title
	// and every link to the note.
	async move(id: string, directory: string | undefined, newTitle: string | undefined, actor: Actor): Promise<{ path: string; updated: string[] }> {
		const plan = await this.mutate(actor, () => {
			const from = this.resolve(id);
			const n = this.store.read(from)!.note;
			if (n.locked) throw lockedError(from);
			const dir = directory === undefined ? from.slice(0, Math.max(0, from.lastIndexOf("/"))) : cleanDir(directory);
			const title = (newTitle ?? "").trim().normalize("NFC") || n.title;
			checkSecrets(title);
			const to = (dir ? dir + "/" : "") + slugify(title) + ".md";
			if (to === from && title === n.title) throw new Error(`${from} already has that directory and title`);
			if (to !== from && this.store.exists(to)) throw new Error(`can't move to ${to}: a note already exists there`);
			const content = this.store.read(from)!.content;
			const changes: FileChange[] = to === from ? [] : [{ path: from, content: null }, { path: to, content }];
			return { changes, message: `move ${from} -> ${to}`, result: { from, to, oldTitle: n.title, title, sources: this.store.backlinks(from).map((h) => h.path) } };
		}, "keep");

		const { from, to, oldTitle, title, sources } = plan;
		const oldFileSlug = slugify(from.slice(from.lastIndexOf("/") + 1).replace(/\.md$/, ""));
		const oldTitleSlug = slugify(oldTitle);
		const titleChanged = slugify(title) !== oldTitleSlug || slugify(title) !== oldFileSlug;
		const newTarget = (target: string): string | null => {
			const t = linkTarget(target);
			if (t.notePath) return t.notePath === from && target !== permalink(to) ? permalink(to) : null;
			return titleChanged && (t.slug === oldFileSlug || t.slug === oldTitleSlug) && target !== title ? title : null;
		};
		const updated = await this.mutate(actor, () => {
			const changes: FileChange[] = [];
			const n = this.store.read(to)!.note;
			n.title = title;
			n.body = rewriteLinks(n.body, newTarget).body;
			n.extra = n.extra.map((l) => (l.startsWith("permalink:") ? `permalink: ${permalink(to)}` : l));
			const self = format(n);
			if (self !== this.store.read(to)!.content) changes.push({ path: to, content: self });
			const touched: string[] = [];
			for (const src of sources) {
				const path = src === from ? to : src;
				if (path === to) continue;
				const s = this.store.read(path);
				if (!s) continue;
				const r = rewriteLinks(s.note.body, newTarget);
				if (r.count === 0) continue;
				s.note.body = r.body;
				changes.push({ path, content: format(s.note) });
				touched.push(path);
			}
			return { changes, message: `relink ${to}`, result: touched };
		}, "keep");
		// A pending review follows the note to its new path.
		this.store.moveInbox(from, to, this.store.read(to)?.content ?? null);
		return { path: to, updated };
	}

	// ---- the inbox -------------------------------------------------------------

	reviewSettings(): ReviewSettings {
		try {
			return { enabled: true, trusted: [], ...JSON.parse(this.store.meta("review") ?? "{}") };
		} catch {
			return { enabled: true, trusted: [] };
		}
	}

	private reviewing(source: string): boolean {
		const r = this.reviewSettings();
		const known = new Set(JSON.parse(this.store.meta("review_sources") ?? "[]") as string[]);
		if (!known.has(source)) this.store.setMeta("review_sources", JSON.stringify([...known, source].sort()));
		return r.enabled && !r.trusted.includes(source);
	}

	async inbox(): Promise<{ items: InboxItem[]; settings: ReviewSettings; sources: string[] }> {
		await this.fresh();
		return { items: this.store.inbox(), settings: this.reviewSettings(), sources: JSON.parse(this.store.meta("review_sources") ?? "[]") };
	}

	async inboxCount(): Promise<number> {
		return this.store.inboxCount();
	}

	async setReviewSettings(settings: ReviewSettings): Promise<ReviewSettings> {
		const clean = { enabled: !!settings.enabled, trusted: [...new Set((settings.trusted ?? []).map(String))] };
		this.store.setMeta("review", JSON.stringify(clean));
		// Changes from apps that are now trusted don't need review either.
		for (const source of clean.trusted) this.store.resolveInbox({ source });
		if (!clean.enabled) this.store.resolveInbox({});
		return clean;
	}

	// accept keeps the change(s) as they are: just clears the review.
	async accept(ids: number[] | "all"): Promise<void> {
		if (ids === "all") this.store.resolveInbox({});
		else for (const id of ids) this.store.resolveInbox({ id });
	}

	// reject undoes an agent's change: the note goes back to how it was
	// before (or away, if the agent created it). An optional reason is added
	// to a pinned "Memory feedback" note, which agents see at the start of
	// every session, so they stop saving that kind of thing.
	async reject(id: number, actor: Actor, reason?: string): Promise<{ path: string }> {
		const item = this.store.inboxItem(id);
		if (!item) throw new Error("that change was already reviewed");
		await this.mutate(actor, () => {
			const current = this.store.read(item.path)?.content ?? null;
			if (current !== item.after) throw new Error(`${item.path} changed again since; open it and edit it instead`);
			if (item.before === null && current === null) return { changes: [], message: "", result: null };
			return { changes: [{ path: item.path, content: item.before }], message: `revert ${item.path} (rejected in review)`, result: null };
		});
		this.store.resolveInbox({ id });
		const why = reason?.trim();
		if (why) {
			const line = `- [instruction] Don't save: ${why.replace(/\s+/g, " ")} (rejected ${new Date().toISOString().slice(0, 10)}, ${item.path})`;
			try {
				await this.edit({ identifier: FEEDBACK, operation: "append", content: line }, actor);
			} catch {
				await this.write({ title: "Memory feedback", directory: "general", pinned: true, content: "What not to save, from reviewing what AI apps wrote.\n\n" + line }, actor);
			}
		}
		return { path: item.path };
	}

	// put saves a note's whole file as a person edited it in the web app.
	// People may edit locked notes: the lock only keeps agents out.
	async put(path: string, content: string, actor: Actor, create: boolean): Promise<string> {
		path = validPath(path);
		checkSecrets(content);
		return this.mutate(actor, () => {
			const exists = this.store.exists(path);
			if (create && exists) throw new Error(`a note already exists at ${path}`);
			if (!create && !exists) throw new Error(`note ${path} not found`);
			const n = parse(path, content);
			if (!n.title.trim()) throw new Error("the note needs a title");
			return { changes: [{ path, content: format(n) }], message: `${create ? "add" : "edit"} ${path}`, result: path };
		});
	}

	async history(limit: number) {
		return Session.log(await this.remote(), Math.min(Math.max(limit, 1), 200));
	}

	async graph(): Promise<{ nodes: { path: string; title: string; pinned: boolean }[]; edges: { from: string; to: string }[] }> {
		await this.fresh();
		return { nodes: this.store.list("").map((h) => ({ path: h.path, title: h.title, pinned: h.pinned })), edges: this.store.edges() };
	}

	// importFiles writes many notes in one commit, skipping paths that exist.
	async importFiles(files: { path: string; content: string }[], actor: Actor, message: string): Promise<{ written: string[]; skipped: string[] }> {
		return this.mutate(actor, () => {
			const written: string[] = [];
			const skipped: string[] = [];
			const changes: FileChange[] = [];
			for (const f of files) {
				const path = validPath(f.path);
				if (this.store.exists(path) || written.includes(path)) skipped.push(path);
				else {
					changes.push({ path, content: f.content });
					written.push(path);
				}
			}
			return { changes, message, result: { written, skipped } };
		});
	}

	async sync(): Promise<{ head: string | null; notes: number }> {
		await this.serialize(async () => {
			await this.syncIndex(await this.openSession());
		});
		return { head: this.store.meta("head") || null, notes: this.store.count() };
	}

	// ---- internals -----------------------------------------------------------

	private resolve(id: string): string {
		id = id.trim().replace(/^memory:\/\//, "").normalize("NFC");
		if (!id) throw new Error("empty note identifier");
		const candidates = [id, id + ".md"];
		const bare = id.replace(/\.md$/, "");
		const slash = bare.lastIndexOf("/");
		try {
			const dir = cleanDir(bare.slice(0, slash + 1));
			candidates.push((dir ? dir + "/" : "") + slugify(bare.slice(slash + 1)) + ".md");
		} catch {
			// not a path
		}
		for (const c of candidates) if (this.store.exists(c)) return c;
		const paths = this.store.findByTitle(id);
		if (paths.length === 1) return paths[0];
		if (paths.length > 1) throw new Error(`several notes are titled "${id}", use a path instead: ${paths.join(", ")}`);
		throw new Error(`note "${id}" not found; use search_notes to find it`);
	}

	// serialize runs fn after every earlier write or sync has finished:
	// Durable Objects interleave requests at await points.
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => {});
		return run;
	}

	private async remote() {
		const repo = this.store.meta("repo");
		if (!repo) throw new Error("workspace is not configured");
		return remoteFor(repoProvider(this.env), repo);
	}

	private async openSession(): Promise<Session> {
		this.session = await Session.open(await this.remote());
		this.lastCheck = Date.now();
		return this.session;
	}

	// fresh makes reads see pushes from elsewhere, checking at most every
	// FRESHNESS_MS.
	private async fresh(): Promise<void> {
		const window = this.env.FRESHNESS_MS !== undefined ? Number(this.env.FRESHNESS_MS) : FRESHNESS_MS;
		if (Date.now() - this.lastCheck < window && this.store.meta("head")) return;
		// Passages may be waiting without a scheduled alarm (e.g. after a
		// model change cleared the vectors); make sure they get embedded.
		await this.embedLater();
		await this.serialize(async () => {
			const head = await Session.remoteHead(await this.remote());
			this.lastCheck = Date.now();
			if (head !== (this.store.meta("head") || null) || !this.session || this.session.head !== head) await this.syncIndex(await this.openSession());
		});
	}

	// syncIndex brings the index in line with the session's commit.
	private async syncIndex(s: Session) {
		const known = this.store.oids();
		const initial = known.size === 0;
		const notes = [...s.blobs].filter(([p]) => p.endsWith(".md") && !p.split("/").some((seg) => seg.startsWith(".")));
		const contents = new Map<string, string>();
		for (const [path, oid] of notes) if (known.get(path) !== oid) contents.set(path, (await s.read(path)) ?? "");
		// Changes an agent pushed from a laptop (the CLI's commits) go to the
		// inbox like changes made here. The head commit tells where they came
		// from; the user's own edits and syncs don't start with "memory:".
		const pushed = initial ? null : pushSource(s.headMessage);
		const record = pushed !== null && this.reviewing(pushed);
		const now = Date.now();
		this.ctx.storage.transactionSync(() => {
			const present = new Set(notes.map(([p]) => p));
			for (const [path, oid] of notes) {
				const content = contents.get(path);
				if (content === undefined) continue;
				const created = Date.parse(parse(path, content).created ?? "");
				const before = record ? (this.store.read(path)?.content ?? null) : null;
				this.store.upsert(path, content, oid, initial && created ? created : s.headTime || Date.now());
				if (record) this.store.recordChange(path, before, content, pushed!, s.headAuthor, now);
			}
			for (const path of known.keys()) {
				if (present.has(path)) continue;
				if (record) this.store.recordChange(path, this.store.read(path)?.content ?? null, null, pushed!, s.headAuthor, now);
				this.store.remove(path);
			}
			this.store.setMeta("head", s.head ?? "");
		});
		await this.embedLater();
	}

	// mutate computes a change from the current notes, commits and pushes it,
	// then updates the index. When a laptop pushed in between, it re-reads
	// and recomputes the change on top, so edits are replayed, never lost.
	private mutate<T>(actor: Actor, fn: () => { changes: FileChange[]; message: string; result: T }, inbox: InboxEffect = actor.agent ? "record" : "resolve"): Promise<T> {
		return this.serialize(async () => {
			for (let attempt = 0; attempt < 5; attempt++) {
				let s = this.session;
				if (!s || attempt > 0 || Date.now() - this.lastCheck > 2000) {
					const head = attempt === 0 && s ? await Session.remoteHead(await this.remote()) : undefined;
					if (attempt > 0 || !s || head !== s.head) {
						s = await this.openSession();
						await this.syncIndex(s);
					}
				}
				const { changes, message, result } = fn();
				if (changes.length === 0) return result;
				try {
					// "(cloud, login)" for the user's own changes in the web app,
					// "(cloud, login, app)" for an AI app's.
					const via = actor.agent && actor.source ? `, ${actor.source}` : "";
					await s!.commit(changes, `memory: ${message} (cloud, ${actor.login}${via})`, {
						name: actor.name || actor.login,
						email: `${actor.login}@users.gitmind`,
					});
				} catch (e) {
					if (e instanceof ConflictError) continue;
					throw e;
				}
				const now = Date.now();
				const notes = changes.filter((c) => c.path.endsWith(".md"));
				const before = new Map(notes.map((c) => [c.path, this.store.read(c.path)?.content ?? null]));
				const source = actor.source ?? "an AI app";
				const record = inbox === "record" && this.reviewing(source);
				this.ctx.storage.transactionSync(() => {
					for (const c of notes) {
						if (c.content === null) this.store.remove(c.path);
						else this.store.upsert(c.path, c.content, s!.blobs.get(c.path)!, now);
						if (record) this.store.recordChange(c.path, before.get(c.path)!, c.content, source, actor.login, now);
						else if (inbox === "resolve") this.store.resolveInbox({ path: c.path });
					}
					this.store.setMeta("head", s!.head ?? "");
				});
				this.lastCheck = now;
				await this.embedLater();
				return result;
			}
			throw new Error("too many concurrent changes to this workspace; try again");
		});
	}
}

// pushSource tells where a pushed commit came from, from the CLI's message
// format "memory: add x.md (laptop, Claude Code)" (or "(laptop)" from older
// CLIs); null for commits that aren't an agent's change (the user's edits,
// syncs, and the cloud's own commits).
export function pushSource(message: string): string | null {
	if (!message.startsWith("memory:")) return null;
	const m = /\(([^()]*)\)\s*$/.exec(message.split("\n")[0]);
	if (!m) return "a laptop";
	const [host, client] = m[1].split(",").map((x) => x.trim());
	if (host === "cloud" || host === "web") return null;
	return client ? `${client} on ${host}` : `the CLI on ${host}`;
}

function lockedError(path: string): Error {
	return new Error(`${path} is locked (locked: true in its frontmatter), meaning the user maintains it by hand; don't change it, and suggest the change to the user instead`);
}

// separator keeps an appended list item in the same Markdown list.
function separator(body: string, addition: string): string {
	const lines = body.replace(/\n+$/, "").split("\n");
	const last = lines[lines.length - 1].trim();
	const next = addition.trim();
	const isItem = (l: string) => l.startsWith("- ") || l.startsWith("* ");
	return isItem(last) && isItem(next) ? "\n" : "\n\n";
}
