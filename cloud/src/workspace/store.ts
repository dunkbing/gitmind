// The search index and note store of one workspace, kept in its Durable
// Object's SQLite. A port of internal/index (Go); notes' full content is kept
// here too, so reads never touch git.

import {
	type Note,
	format,
	inlineTags,
	splitHistory,
	linkTarget,
	links,
	normalizeTags,
	observations,
	parse,
	slugify,
	summary,
} from "../engine/notes";
import { dot, hash, passages } from "./embed";

const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
	id         INTEGER PRIMARY KEY,
	path       TEXT NOT NULL UNIQUE,
	slug       TEXT NOT NULL,
	title      TEXT NOT NULL,
	title_slug TEXT NOT NULL,
	tags       TEXT NOT NULL,
	summary    TEXT NOT NULL,
	pinned     INTEGER NOT NULL,
	oid        TEXT NOT NULL,     -- git blob id of the content, to detect changes
	content    TEXT NOT NULL,     -- the whole file
	updated    INTEGER NOT NULL   -- ms since epoch: when the note last changed
);
CREATE INDEX IF NOT EXISTS notes_slug ON notes (slug);
CREATE INDEX IF NOT EXISTS notes_title_slug ON notes (title_slug);
CREATE INDEX IF NOT EXISTS notes_updated ON notes (updated);
-- body is the note without its History sections, which go in history.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, tags, body, history, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS links (source_id INTEGER NOT NULL, target TEXT NOT NULL, target_path TEXT NOT NULL, target_slug TEXT NOT NULL, relation TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS links_source ON links (source_id);
CREATE INDEX IF NOT EXISTS links_slug ON links (target_slug);
CREATE TABLE IF NOT EXISTS note_tags (note_id INTEGER NOT NULL, tag TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS note_tags_tag ON note_tags (tag, note_id);
-- current is 0 for facts kept under a History heading.
CREATE TABLE IF NOT EXISTS observations (note_id INTEGER NOT NULL, category TEXT NOT NULL, text TEXT NOT NULL, current INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS observations_category ON observations (category, note_id);
-- Passages for semantic search; vec is NULL until embedded. history is 1 for
-- passages from History sections.
CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL, text TEXT NOT NULL, hash INTEGER NOT NULL, vec BLOB, history INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_note ON chunks (note_id);
`;

const RESOLVES = `(l.target_path = t.path OR (l.target_path = '' AND (l.target_slug = t.slug OR l.target_slug = t.title_slug)))`;
const HIT_COLUMNS = `n.path, n.title, n.tags, n.updated, n.summary, n.pinned`;

export interface Hit {
	path: string;
	title: string;
	tags: string[];
	updated: number;
	summary: string;
	pinned: boolean;
	snippet: string;
	observations?: string[];
	history?: boolean; // matched only in the note's History, with Query.includeHistory
}

export interface LinkHit extends Hit {
	relation: string;
}

export interface Query {
	text?: string;
	dir?: string;
	tags?: string[];
	category?: string;
	since?: number; // ms
	before?: number; // ms
	limit?: number;
	// "hybrid" (the default) ranks by keywords and meaning together when the
	// workspace has embeddings; "keyword" and "semantic" use one of them.
	mode?: "hybrid" | "keyword" | "semantic";
	// Also match facts kept under History headings, which are otherwise left
	// out; notes matched only there come last.
	includeHistory?: boolean;
}

// A current fact and the note it's in.
export interface Fact {
	path: string;
	title: string;
	category: string;
	text: string;
}

type Part = "current" | "history";
const COLUMNS: Record<Part, { filter: string; snippet: number }> = {
	current: { filter: "{title tags body}", snippet: 2 },
	history: { filter: "history", snippet: 3 },
};

// A change an AI app made, waiting for the user's review. One per note:
// later changes to the same note extend it.
export interface InboxItem {
	id: number;
	path: string;
	before: string | null; // null: the agent created the note
	after: string | null; // null: the agent deleted it
	source: string; // which app (and machine) made it
	actor: string;
	created: number;
	updated: number;
}

// The inbox isn't an index: it can't be rebuilt from git, so it lives
// outside SCHEMA and survives schema changes.
const INBOX = `CREATE TABLE IF NOT EXISTS inbox (
	id      INTEGER PRIMARY KEY,
	path    TEXT NOT NULL UNIQUE,
	before  TEXT,
	after   TEXT,
	source  TEXT NOT NULL,
	actor   TEXT NOT NULL,
	created INTEGER NOT NULL,
	updated INTEGER NOT NULL
)`;

type Row = Record<string, SqlStorageValue>;

export class Store {
	constructor(private sql: SqlStorage) {
		const version = this.meta("schema_version");
		if (version !== String(SCHEMA_VERSION)) {
			for (const t of ["chunks", "observations", "note_tags", "links", "notes_fts", "notes"]) sql.exec(`DROP TABLE IF EXISTS ${t}`);
			sql.exec(SCHEMA);
			this.setMeta("schema_version", String(SCHEMA_VERSION));
			this.setMeta("head", "");
		}
		sql.exec(INBOX);
	}

	// ---- inbox ---------------------------------------------------------------

	// recordChange adds an agent's change to the inbox, or extends the
	// pending one for the same note (keeping its original "before").
	recordChange(path: string, before: string | null, after: string | null, source: string, actor: string, now: number) {
		const rows = this.sql.exec(`SELECT before, source FROM inbox WHERE path = ?`, path).toArray();
		if (rows.length) {
			const original = rows[0].before as string | null;
			if (original === after) {
				this.sql.exec(`DELETE FROM inbox WHERE path = ?`, path); // changed back: nothing to review
				return;
			}
			const sources = [...new Set([...String(rows[0].source).split(", "), source])].join(", ");
			this.sql.exec(`UPDATE inbox SET after = ?, source = ?, actor = ?, updated = ? WHERE path = ?`, after, sources, actor, now, path);
			return;
		}
		if (before === after) return;
		this.sql.exec(`INSERT INTO inbox (path, before, after, source, actor, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)`, path, before, after, source, actor, now, now);
	}

	moveInbox(from: string, to: string, after: string | null) {
		if (from === to) {
			this.sql.exec(`UPDATE inbox SET after = ? WHERE path = ?`, after, to);
			return;
		}
		this.sql.exec(`UPDATE OR REPLACE inbox SET path = ?, after = ? WHERE path = ?`, to, after, from);
	}

	inbox(): InboxItem[] {
		return this.sql
			.exec(`SELECT * FROM inbox ORDER BY updated DESC`)
			.toArray()
			.map((r) => ({
				id: Number(r.id),
				path: String(r.path),
				before: r.before === null ? null : String(r.before),
				after: r.after === null ? null : String(r.after),
				source: String(r.source),
				actor: String(r.actor),
				created: Number(r.created),
				updated: Number(r.updated),
			}));
	}

	inboxItem(id: number): InboxItem | null {
		return this.inbox().find((i) => i.id === id) ?? null;
	}

	inboxCount(): number {
		return Number(this.sql.exec(`SELECT count(*) AS c FROM inbox`).one().c);
	}

	resolveInbox(where: { id?: number; path?: string; source?: string }) {
		if (where.id !== undefined) this.sql.exec(`DELETE FROM inbox WHERE id = ?`, where.id);
		else if (where.path !== undefined) this.sql.exec(`DELETE FROM inbox WHERE path = ?`, where.path);
		else if (where.source !== undefined) this.sql.exec(`DELETE FROM inbox WHERE source = ?`, where.source);
		else this.sql.exec(`DELETE FROM inbox`);
	}

	meta(key: string): string | null {
		this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		const rows = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray();
		return rows.length ? String(rows[0].value) : null;
	}

	setMeta(key: string, value: string) {
		this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
	}

	// Files currently indexed, path → blob oid.
	oids(): Map<string, string> {
		const out = new Map<string, string>();
		for (const r of this.sql.exec(`SELECT path, oid FROM notes`)) out.set(String(r.path), String(r.oid));
		return out;
	}

	read(path: string): { note: Note; content: string; updated: number } | null {
		const rows = this.sql.exec(`SELECT content, updated FROM notes WHERE path = ?`, path).toArray();
		if (!rows.length) return null;
		const content = String(rows[0].content);
		return { note: parse(path, content), content, updated: Number(rows[0].updated) };
	}

	exists(path: string): boolean {
		return this.sql.exec(`SELECT 1 FROM notes WHERE path = ?`, path).toArray().length > 0;
	}

	upsert(path: string, content: string, oid: string, updated: number) {
		const n = parse(path, content);
		const allTags = normalizeTags([...n.tags, ...inlineTags(n.body)]);
		const tags = allTags.join(" ");
		const slug = slugify(path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""));
		const existing = this.sql.exec(`SELECT id FROM notes WHERE path = ?`, path).toArray();
		// Passages whose text didn't change keep their vectors.
		const kept = new Map<number, ArrayBuffer>();
		if (existing.length)
			for (const r of this.sql.exec(`SELECT hash, vec FROM chunks WHERE note_id = ? AND vec IS NOT NULL`, existing[0].id)) kept.set(Number(r.hash), r.vec as ArrayBuffer);
		let id: number;
		if (existing.length) {
			id = Number(existing[0].id);
			this.sql.exec(
				`UPDATE notes SET slug = ?, title = ?, title_slug = ?, tags = ?, summary = ?, pinned = ?, oid = ?, content = ?, updated = ? WHERE id = ?`,
				slug, n.title, slugify(n.title), tags, summary(n.body), n.pinned ? 1 : 0, oid, content, updated, id,
			);
			this.removeDerived(id);
		} else {
			id = Number(
				this.sql
					.exec(
						`INSERT INTO notes (path, slug, title, title_slug, tags, summary, pinned, oid, content, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
						path, slug, n.title, slugify(n.title), tags, summary(n.body), n.pinned ? 1 : 0, oid, content, updated,
					)
					.one().id,
			);
		}
		const { current, history } = splitHistory(n.body);
		this.sql.exec(`INSERT INTO notes_fts (rowid, title, tags, body, history) VALUES (?, ?, ?, ?, ?)`, id, n.title, tags, current, history);
		for (const l of links(n.body)) {
			const t = linkTarget(l.target);
			this.sql.exec(`INSERT INTO links (source_id, target, target_path, target_slug, relation) VALUES (?, ?, ?, ?, ?)`, id, l.target, t.notePath, t.slug, l.relation);
		}
		for (const t of allTags) this.sql.exec(`INSERT INTO note_tags (note_id, tag) VALUES (?, ?)`, id, t);
		for (const [part, isCurrent] of [[current, 1], [history, 0]] as const)
			for (const o of observations(part)) this.sql.exec(`INSERT INTO observations (note_id, category, text, current) VALUES (?, ?, ?, ?)`, id, o.category, o.text, isCurrent);
		const parts = [{ body: current, history: 0 }, ...(history.trim() ? [{ body: history, history: 1 }] : [])];
		for (const part of parts)
			for (const text of passages({ ...n, body: part.body })) {
				const h = hash(text);
				this.sql.exec(`INSERT INTO chunks (note_id, text, hash, vec, history) VALUES (?, ?, ?, ?, ?)`, id, text, h, kept.get(h) ?? null, part.history);
			}
		this.vectors = null;
	}

	remove(path: string) {
		const rows = this.sql.exec(`SELECT id FROM notes WHERE path = ?`, path).toArray();
		if (!rows.length) return;
		const id = Number(rows[0].id);
		this.removeDerived(id);
		this.sql.exec(`DELETE FROM notes WHERE id = ?`, id);
	}

	private removeDerived(id: number) {
		this.sql.exec(`DELETE FROM notes_fts WHERE rowid = ?`, id);
		this.sql.exec(`DELETE FROM links WHERE source_id = ?`, id);
		this.sql.exec(`DELETE FROM note_tags WHERE note_id = ?`, id);
		this.sql.exec(`DELETE FROM observations WHERE note_id = ?`, id);
		this.sql.exec(`DELETE FROM chunks WHERE note_id = ?`, id);
		this.vectors = null;
	}

	// ---- embeddings ----------------------------------------------------------

	// Every embedded passage, loaded once and kept until notes change.
	private vectors: { noteId: number; chunkId: number; history: boolean; vec: Float32Array }[] | null = null;

	private loadVectors() {
		this.vectors ??= this.sql
			.exec(`SELECT id, note_id, history, vec FROM chunks WHERE vec IS NOT NULL`)
			.toArray()
			.map((r) => ({ chunkId: Number(r.id), noteId: Number(r.note_id), history: Number(r.history) === 1, vec: new Float32Array(r.vec as ArrayBuffer) }));
		return this.vectors;
	}

	hasVectors(): boolean {
		return this.sql.exec(`SELECT 1 FROM chunks WHERE vec IS NOT NULL LIMIT 1`).toArray().length > 0;
	}

	embeddingStats(): { passages: number; embedded: number } {
		const r = this.sql.exec(`SELECT count(*) AS passages, count(vec) AS embedded FROM chunks`).one();
		return { passages: Number(r.passages), embedded: Number(r.embedded) };
	}

	pendingCount(): number {
		return Number(this.sql.exec(`SELECT count(*) AS c FROM chunks WHERE vec IS NULL`).one().c);
	}

	pendingChunks(limit: number): { id: number; hash: number; text: string }[] {
		return this.sql
			.exec(`SELECT id, hash, text FROM chunks WHERE vec IS NULL ORDER BY id LIMIT ?`, limit)
			.toArray()
			.map((r) => ({ id: Number(r.id), hash: Number(r.hash), text: String(r.text) }));
	}

	// setVectors stores embeddings, skipping passages that changed meanwhile.
	setVectors(items: { id: number; hash: number; vec: Float32Array }[]) {
		for (const it of items) {
			const buf = it.vec.buffer.slice(it.vec.byteOffset, it.vec.byteOffset + it.vec.byteLength);
			this.sql.exec(`UPDATE chunks SET vec = ? WHERE id = ? AND hash = ?`, buf, it.id, it.hash);
		}
		this.vectors = null;
	}

	clearVectors() {
		this.sql.exec(`UPDATE chunks SET vec = NULL`);
		this.vectors = null;
	}

	// semantic ranks notes by their closest passage to the query vector.
	private semantic(vec: Float32Array, q: Query, limit: number, minScore: number, excludeId?: number, part: Part = "current"): (Hit & { score: number })[] {
		const [filter, args] = filterSQL(q);
		const allowed = filter ? new Set(this.sql.exec(`SELECT n.id FROM notes n WHERE 1 = 1${filter}`, ...args).toArray().map((r) => Number(r.id))) : null;
		const best = new Map<number, { score: number; chunkId: number }>();
		for (const v of this.loadVectors()) {
			if ((allowed && !allowed.has(v.noteId)) || v.noteId === excludeId || v.history !== (part === "history")) continue;
			if (v.vec.length !== vec.length) continue;
			const score = dot(v.vec, vec);
			if (score < minScore) continue;
			const b = best.get(v.noteId);
			if (!b || score > b.score) best.set(v.noteId, { score, chunkId: v.chunkId });
		}
		// Scores vary by query; keep the notes close to the best one.
		const sorted = [...best].sort((a, b) => b[1].score - a[1].score);
		const cutoff = sorted.length ? sorted[0][1].score - 0.12 : 0;
		const top = sorted.filter(([, b]) => b.score >= cutoff).slice(0, limit);
		const out: (Hit & { score: number })[] = [];
		for (const [noteId, { score, chunkId }] of top) {
			const row = this.sql.exec(`SELECT ${HIT_COLUMNS}, c.text AS snippet FROM notes n JOIN chunks c ON c.id = ? WHERE n.id = ?`, chunkId, noteId).toArray()[0];
			if (!row) continue;
			const hit = toHit(row);
			// The passage, without the title line the index prefixed it with.
			hit.snippet = hit.snippet.slice(hit.snippet.indexOf("\n") + 1).replace(/\s+/g, " ").slice(0, 240);
			out.push({ ...hit, score });
		}
		return out;
	}

	// related finds the notes closest in meaning to a note: by the average of
	// its passages' vectors.
	related(path: string, limit: number, minScore: number): Hit[] {
		const id = this.sql.exec(`SELECT id FROM notes WHERE path = ?`, path).toArray()[0]?.id;
		if (id === undefined) return [];
		const own = this.loadVectors().filter((v) => v.noteId === Number(id));
		if (!own.length) return [];
		const mean = new Float32Array(own[0].vec.length);
		for (const v of own) for (let i = 0; i < mean.length; i++) mean[i] += v.vec[i];
		let n = 0;
		for (const x of mean) n += x * x;
		n = Math.sqrt(n) || 1;
		for (let i = 0; i < mean.length; i++) mean[i] /= n;
		return this.semantic(mean, {}, limit, minScore, Number(id)).map(({ score: _, ...h }) => h);
	}

	count(): number {
		return Number(this.sql.exec(`SELECT count(*) AS c FROM notes`).one().c);
	}

	// search: with text, notes with every word first (BM25 weighted title >
	// tags > body, nudged towards recent notes), then notes with some words;
	// without text, matching notes newest first.
	//
	// With a query vector (hybrid search), the keyword and semantic rankings
	// are merged by reciprocal rank fusion: a note ranked well by either
	// comes first, one ranked well by both comes before it.
	search(q: Query, vec?: { vec: Float32Array; minScore: number }): Hit[] {
		const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 100) : 10;
		let hits = this.searchPart(q, limit, "current", vec);
		if (q.includeHistory && hits.length < limit && ftsTerms(q.text ?? "").length > 0) {
			const seen = new Set(hits.map((h) => h.path));
			for (const h of this.searchPart(q, limit, "history", vec)) {
				if (hits.length >= limit) break;
				if (!seen.has(h.path)) hits.push({ ...h, history: true });
			}
		}
		const category = q.category?.trim().toLowerCase();
		if (category) {
			for (const h of hits) {
				h.observations = this.sql
					.exec(
						`SELECT o.text FROM observations o JOIN notes n ON n.id = o.note_id WHERE n.path = ? AND o.category = ? AND (o.current OR ?) ORDER BY o.rowid`,
						h.path, category, q.includeHistory ? 1 : 0,
					)
					.toArray()
					.map((r) => String(r.text));
			}
		}
		return hits;
	}

	// searchPart searches the notes without their History sections, or only
	// those sections.
	private searchPart(q: Query, limit: number, part: Part, vec?: { vec: Float32Array; minScore: number }): Hit[] {
		const [filter, args] = filterSQL(q);
		const terms = ftsTerms(q.text ?? "");
		let hits: Hit[];
		if (vec && terms.length > 0) {
			const keyword = q.mode === "semantic" ? [] : this.keyword(terms, part, filter, args, limit * 2);
			const semantic = this.semantic(vec.vec, q, limit * 2, vec.minScore, undefined, part);
			const score = new Map<string, number>();
			const byPath = new Map<string, Hit>();
			const K = 60;
			keyword.forEach((h, i) => {
				score.set(h.path, (score.get(h.path) ?? 0) + 1 / (K + i));
				byPath.set(h.path, h);
			});
			semantic.forEach(({ score: _, ...h }, i) => {
				score.set(h.path, (score.get(h.path) ?? 0) + 1 / (K + i));
				if (!byPath.has(h.path)) byPath.set(h.path, h);
			});
			hits = [...score].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p]) => byPath.get(p)!);
		} else if (terms.length === 0) {
			hits = this.query(`SELECT ${HIT_COLUMNS}, '' AS snippet FROM notes n WHERE 1 = 1${filter} ORDER BY n.updated DESC LIMIT ?`, ...args, limit);
		} else {
			hits = this.keyword(terms, part, filter, args, limit);
		}
		return hits;
	}

	// keyword: notes with every word first, then notes with some words.
	private keyword(terms: string[], part: Part, filter: string, args: SqlStorageValue[], limit: number): Hit[] {
		const hits = this.fts(terms.join(" "), part, filter, args, limit);
		if (terms.length > 1 && hits.length < limit) {
			const seen = new Set(hits.map((h) => h.path));
			for (const h of this.fts(terms.join(" OR "), part, filter, args, limit)) {
				if (hits.length >= limit) break;
				if (!seen.has(h.path)) hits.push(h);
			}
		}
		return hits;
	}

	private fts(match: string, part: Part, filter: string, args: SqlStorageValue[], limit: number): Hit[] {
		const cols = COLUMNS[part];
		// 30 days in ms: recent notes score up to 1.3x, fading over months.
		return this.query(
			`SELECT ${HIT_COLUMNS}, snippet(notes_fts, ${cols.snippet}, '**', '**', '…', 16) AS snippet
			 FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
			 WHERE notes_fts MATCH ?${filter}
			 ORDER BY bm25(notes_fts, 10.0, 5.0, 1.0, 1.0) * (1.0 + 0.3 / (1.0 + (? - n.updated) / 2592000000.0))
			 LIMIT ?`,
			`${cols.filter} : (${match})`, ...args, Date.now(), limit,
		);
	}

	// currentFacts returns the current observations in category ("" for any)
	// of the notes under any of dirs ("" for the top level).
	currentFacts(category: string, dirs: string[]): Fact[] {
		if (!dirs.length) return [];
		const c = category.trim().toLowerCase();
		const where = dirs.map((d) => (d === "" ? `n.path NOT LIKE '%/%'` : `n.path LIKE ? || '/%'`)).join(" OR ");
		return this.sql
			.exec(
				`SELECT n.path, n.title, o.category, o.text FROM observations o JOIN notes n ON n.id = o.note_id
				 WHERE o.current AND (? = '' OR o.category = ?) AND (${where}) ORDER BY n.updated DESC, o.rowid`,
				c, c, ...dirs.filter((d) => d !== ""),
			)
			.toArray()
			.map((r) => ({ path: String(r.path), title: String(r.title), category: String(r.category), text: String(r.text) }));
	}

	recent(limit: number): Hit[] {
		return this.query(`SELECT ${HIT_COLUMNS}, '' AS snippet FROM notes n ORDER BY n.updated DESC LIMIT ?`, limit);
	}

	list(dir: string): Hit[] {
		return this.query(`SELECT ${HIT_COLUMNS}, '' AS snippet FROM notes n WHERE ? = '' OR n.path LIKE ? || '/%' ORDER BY n.path`, dir, dir);
	}

	// edges lists every resolved link, for the graph view.
	edges(): { from: string; to: string }[] {
		return this.sql
			.exec(`SELECT DISTINCT s.path AS source, t.path AS target FROM links l JOIN notes s ON s.id = l.source_id JOIN notes t ON ${RESOLVES} WHERE s.id != t.id`)
			.toArray()
			.map((r) => ({ from: String(r.source), to: String(r.target) }));
	}

	findByTitle(title: string): string[] {
		return this.sql.exec(`SELECT path FROM notes WHERE title = ? COLLATE NOCASE ORDER BY path`, title).toArray().map((r) => String(r.path));
	}

	outgoing(path: string): { hits: LinkHit[]; missing: string[] } {
		const rows = this.sql
			.exec(
				`SELECT l.target, l.relation, t.path, t.title, t.tags, t.updated, t.summary, t.pinned
				 FROM links l JOIN notes s ON s.id = l.source_id
				 LEFT JOIN notes t ON ${RESOLVES} AND t.id != s.id
				 WHERE s.path = ? ORDER BY l.rowid, t.path`,
				path,
			)
			.toArray();
		const hits: LinkHit[] = [];
		const missing: string[] = [];
		for (const r of rows) {
			if (r.path === null) missing.push(String(r.target));
			else hits.push({ ...toHit({ ...r, snippet: "" }), relation: String(r.relation) });
		}
		return { hits, missing };
	}

	backlinks(path: string): LinkHit[] {
		return this.sql
			.exec(
				`SELECT DISTINCT s.path, s.title, s.tags, s.updated, s.summary, s.pinned, l.relation
				 FROM links l JOIN notes s ON s.id = l.source_id JOIN notes t ON ${RESOLVES}
				 WHERE t.path = ? AND s.id != t.id ORDER BY s.updated DESC`,
				path,
			)
			.toArray()
			.map((r) => ({ ...toHit({ ...r, snippet: "" }), relation: String(r.relation) }));
	}

	// similar finds notes whose title or tags share a significant word with
	// the given note's title or tags: likely duplicates.
	similar(path: string, title: string, tags: string[], limit: number): Hit[] {
		const words = [...new Set(ftsWords(`${title} ${tags.join(" ")}`).map((w) => w.toLowerCase()))].filter(
			(w) => [...w].length >= 3 && !STOP_WORDS.has(w),
		);
		if (!words.length) return [];
		return this.query(
			`SELECT ${HIT_COLUMNS}, '' AS snippet FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
			 WHERE notes_fts MATCH ? AND n.path != ? ORDER BY bm25(notes_fts, 10.0, 5.0, 1.0) LIMIT ?`,
			`{title tags} : (${words.map((w) => `"${w}"*`).join(" OR ")})`, path, limit,
		);
	}

	private query(sql: string, ...args: SqlStorageValue[]): Hit[] {
		return this.sql.exec(sql, ...args).toArray().map(toHit);
	}
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "into", "about", "notes", "note", "how", "what", "why", "when", "use", "using", "our", "new", "old"]);

function toHit(r: Row): Hit {
	return {
		path: String(r.path),
		title: String(r.title),
		tags: String(r.tags).split(" ").filter(Boolean),
		updated: Number(r.updated),
		summary: String(r.summary ?? ""),
		pinned: Number(r.pinned) === 1,
		snippet: String(r.snippet ?? ""),
	};
}

function filterSQL(q: Query): [string, SqlStorageValue[]] {
	let sql = "";
	const args: SqlStorageValue[] = [];
	if (q.dir) {
		sql += ` AND n.path LIKE ? || '/%'`;
		args.push(q.dir);
	}
	for (const t of normalizeTags(q.tags ?? [])) {
		sql += ` AND EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag = ?)`;
		args.push(t);
	}
	const c = q.category?.trim().toLowerCase();
	if (c) {
		sql += ` AND EXISTS (SELECT 1 FROM observations o WHERE o.note_id = n.id AND o.category = ? AND (o.current OR ?))`;
		args.push(c, q.includeHistory ? 1 : 0);
	}
	if (q.since) {
		sql += ` AND n.updated >= ?`;
		args.push(q.since);
	}
	if (q.before) {
		sql += ` AND n.updated < ?`;
		args.push(q.before);
	}
	return [sql, args];
}

const ftsWords = (s: string) => s.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);

// Quoted prefix terms, so user input can never be parsed as FTS syntax.
const ftsTerms = (q: string) => ftsWords(q).map((w) => `"${w}"*`);

