// The search index and note store of one workspace, kept in its Durable
// Object's SQLite. A port of internal/index (Go); notes' full content is kept
// here too, so reads never touch git.

import {
	type Note,
	format,
	inlineTags,
	linkTarget,
	links,
	normalizeTags,
	observations,
	parse,
	slugify,
	summary,
} from "../engine/notes";

const SCHEMA_VERSION = 1;

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
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, tags, body, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS links (source_id INTEGER NOT NULL, target TEXT NOT NULL, target_path TEXT NOT NULL, target_slug TEXT NOT NULL, relation TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS links_source ON links (source_id);
CREATE INDEX IF NOT EXISTS links_slug ON links (target_slug);
CREATE TABLE IF NOT EXISTS note_tags (note_id INTEGER NOT NULL, tag TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS note_tags_tag ON note_tags (tag, note_id);
CREATE TABLE IF NOT EXISTS observations (note_id INTEGER NOT NULL, category TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS observations_category ON observations (category, note_id);
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
}

type Row = Record<string, SqlStorageValue>;

export class Store {
	constructor(private sql: SqlStorage) {
		const version = this.meta("schema_version");
		if (version !== String(SCHEMA_VERSION)) {
			for (const t of ["observations", "note_tags", "links", "notes_fts", "notes"]) sql.exec(`DROP TABLE IF EXISTS ${t}`);
			sql.exec(SCHEMA);
			this.setMeta("schema_version", String(SCHEMA_VERSION));
			this.setMeta("head", "");
		}
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
		this.sql.exec(`INSERT INTO notes_fts (rowid, title, tags, body) VALUES (?, ?, ?, ?)`, id, n.title, tags, n.body);
		for (const l of links(n.body)) {
			const t = linkTarget(l.target);
			this.sql.exec(`INSERT INTO links (source_id, target, target_path, target_slug, relation) VALUES (?, ?, ?, ?, ?)`, id, l.target, t.notePath, t.slug, l.relation);
		}
		for (const t of allTags) this.sql.exec(`INSERT INTO note_tags (note_id, tag) VALUES (?, ?)`, id, t);
		for (const o of observations(n.body)) this.sql.exec(`INSERT INTO observations (note_id, category, text) VALUES (?, ?, ?)`, id, o.category, o.text);
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
	}

	count(): number {
		return Number(this.sql.exec(`SELECT count(*) AS c FROM notes`).one().c);
	}

	// search: with text, notes with every word first (BM25 weighted title >
	// tags > body, nudged towards recent notes), then notes with some words;
	// without text, matching notes newest first.
	search(q: Query): Hit[] {
		const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 100) : 10;
		const [filter, args] = filterSQL(q);
		const terms = ftsTerms(q.text ?? "");
		let hits: Hit[];
		if (terms.length === 0) {
			hits = this.query(`SELECT ${HIT_COLUMNS}, '' AS snippet FROM notes n WHERE 1 = 1${filter} ORDER BY n.updated DESC LIMIT ?`, ...args, limit);
		} else {
			hits = this.fts(terms.join(" "), filter, args, limit);
			if (terms.length > 1 && hits.length < limit) {
				const seen = new Set(hits.map((h) => h.path));
				for (const h of this.fts(terms.join(" OR "), filter, args, limit)) {
					if (hits.length >= limit) break;
					if (!seen.has(h.path)) hits.push(h);
				}
			}
		}
		const category = q.category?.trim().toLowerCase();
		if (category) {
			for (const h of hits) {
				h.observations = this.sql
					.exec(`SELECT o.text FROM observations o JOIN notes n ON n.id = o.note_id WHERE n.path = ? AND o.category = ? ORDER BY o.rowid`, h.path, category)
					.toArray()
					.map((r) => String(r.text));
			}
		}
		return hits;
	}

	private fts(match: string, filter: string, args: SqlStorageValue[], limit: number): Hit[] {
		// 30 days in ms: recent notes score up to 1.3x, fading over months.
		return this.query(
			`SELECT ${HIT_COLUMNS}, snippet(notes_fts, 2, '**', '**', '…', 16) AS snippet
			 FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid
			 WHERE notes_fts MATCH ?${filter}
			 ORDER BY bm25(notes_fts, 10.0, 5.0, 1.0) * (1.0 + 0.3 / (1.0 + (? - n.updated) / 2592000000.0))
			 LIMIT ?`,
			match, ...args, Date.now(), limit,
		);
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
		sql += ` AND EXISTS (SELECT 1 FROM observations o WHERE o.note_id = n.id AND o.category = ?)`;
		args.push(c);
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

