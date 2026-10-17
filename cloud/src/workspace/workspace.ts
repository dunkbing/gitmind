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
import { buildContext, sessionContext } from "./context";
import { type Hit, type Query, Store } from "./store";

export interface Actor {
	login: string;
	name?: string;
}

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

// Files every workspace repository starts with, matching the CLI's init.
const INIT_FILES: FileChange[] = [
	{ path: ".gitattributes", content: "*.md merge=union\n" },
	{ path: ".gitignore", content: ".memory-go/\n" },
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

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.store = new Store(ctx.storage.sql);
	}

	// configure binds this object to its repository, creating the repository
	// with the standard files if needed. Safe to call again.
	async configure(repoName: string): Promise<void> {
		await this.serialize(async () => {
			this.store.setMeta("repo", repoName);
			await repoProvider(this.env).create(repoName);
			const s = await this.openSession();
			const missing = INIT_FILES.filter((f) => !s.blobs.has(f.path));
			if (missing.length) await s.commit(missing, "memory-go: init", { name: "memory-go", email: "cloud@memory-go" });
			await this.syncIndex(s);
		});
	}

	// ---- reads -------------------------------------------------------------

	async search(q: Query): Promise<Hit[]> {
		await this.fresh();
		return this.store.search({ ...q, dir: q.dir ? cleanDir(q.dir) : "" });
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

	async stats(): Promise<{ notes: number; head: string | null }> {
		await this.fresh();
		return { notes: this.store.count(), head: this.store.meta("head") || null };
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
		});

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
		});
		return { path: to, updated };
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
		this.ctx.storage.transactionSync(() => {
			for (const [path, oid] of notes) {
				const content = contents.get(path);
				if (content === undefined) continue;
				const created = Date.parse(parse(path, content).created ?? "");
				this.store.upsert(path, content, oid, initial && created ? created : s.headTime || Date.now());
			}
			const present = new Set(notes.map(([p]) => p));
			for (const path of known.keys()) if (!present.has(path)) this.store.remove(path);
			this.store.setMeta("head", s.head ?? "");
		});
	}

	// mutate computes a change from the current notes, commits and pushes it,
	// then updates the index. When a laptop pushed in between, it re-reads
	// and recomputes the change on top, so edits are replayed, never lost.
	private mutate<T>(actor: Actor, fn: () => { changes: FileChange[]; message: string; result: T }): Promise<T> {
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
					await s!.commit(changes, `memory: ${message} (cloud, ${actor.login})`, {
						name: actor.name || actor.login,
						email: `${actor.login}@users.memory-go`,
					});
				} catch (e) {
					if (e instanceof ConflictError) continue;
					throw e;
				}
				const now = Date.now();
				this.ctx.storage.transactionSync(() => {
					for (const c of changes) {
						if (!c.path.endsWith(".md")) continue;
						if (c.content === null) this.store.remove(c.path);
						else this.store.upsert(c.path, c.content, s!.blobs.get(c.path)!, now);
					}
					this.store.setMeta("head", s!.head ?? "");
				});
				this.lastCheck = now;
				return result;
			}
			throw new Error("too many concurrent changes to this workspace; try again");
		});
	}
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
