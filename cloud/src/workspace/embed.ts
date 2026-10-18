// Embeddings for semantic search: notes are split into passages, each
// embedded once (and again only when its text changes) and kept in the
// workspace's SQLite next to the keyword index. Vectors are an index, like
// the FTS tables: rebuildable from git, never committed.

import { type Note, unfencedLines } from "../engine/notes";

export interface Embedder {
	id: string; // model identifier, stored so a model change re-embeds
	dims: number;
	// Similarity below which a passage isn't considered a match.
	minScore: number;
	// Queries and the passages they should find are embedded differently.
	embed(texts: string[], kind: "query" | "document"): Promise<Float32Array[]>;
}

// Qwen3-Embedding is multilingual (a Vietnamese query finds an English note)
// and embeds queries and documents asymmetrically. On a sample of notes it
// ranked the right note first for 8 of 8 queries, against 7 for bge-m3 and
// EmbeddingGemma, with about twice bge-m3's margin over the next note.
const MODEL = "@cf/qwen/qwen3-embedding-0.6b";

export function embedderFor(env: Env): Embedder | null {
	const ai = (env as { AI?: Ai }).AI;
	if (ai) {
		return {
			id: MODEL,
			dims: 1024,
			minScore: 0.25,
			async embed(texts, kind) {
				const input = kind === "query" ? { queries: texts } : { documents: texts };
				const out = (await ai.run(MODEL, input)) as { data?: number[][]; response?: number[][] };
				const data = out.data ?? out.response;
				if (!data || data.length !== texts.length) throw new Error("embedding failed: unexpected response from Workers AI");
				return data.map((v) => normalize(Float32Array.from(v)));
			},
		};
	}
	// Tests and local development without Workers AI: a deterministic
	// embedding from hashed words and character trigrams. It finds
	// near-matches in wording, not meaning, but exercises the same pipeline.
	if (env.DEV_EMBEDDINGS) return hashingEmbedder;
	return null;
}

const hashingEmbedder: Embedder = {
	id: "dev-hashing-v1",
	dims: 512,
	minScore: 0.1,
	async embed(texts) {
		return texts.map((t) => {
			const v = new Float32Array(512);
			const words = t.toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
			for (const w of words) {
				v[hash(w) % 512] += 1;
				const padded = ` ${w} `;
				for (let i = 0; i + 3 <= padded.length; i++) v[hash(padded.slice(i, i + 3)) % 512] += 0.5;
			}
			return normalize(v);
		});
	},
};

export function normalize(v: Float32Array): Float32Array {
	let n = 0;
	for (const x of v) n += x * x;
	n = Math.sqrt(n) || 1;
	for (let i = 0; i < v.length; i++) v[i] /= n;
	return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}

// hash is FNV-1a: stable across runs, to recognize unchanged passages.
export function hash(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

const MAX_CHARS = 900;
const MAX_PASSAGES = 64;

// passages splits a note into the texts that get embedded: one per section
// (under a heading), cut into pieces of at most MAX_CHARS at line breaks,
// each prefixed with the note's title and heading so it stands on its own.
export function passages(n: Note): string[] {
	const out: string[] = [];
	const head = (heading: string) => (heading ? `${n.title} › ${heading}` : n.title);
	let heading = "";
	let buf: string[] = [];
	let size = 0;
	const flush = () => {
		const text = buf.join("\n").trim();
		if (text) out.push(`${head(heading)}\n${text}`);
		buf = [];
		size = 0;
	};
	for (const line of unfencedLines(n.body)) {
		const h = /^#{1,6}\s+(.+)$/.exec(line);
		if (h) {
			flush();
			heading = h[1].trim();
			continue;
		}
		if (size + line.length > MAX_CHARS && size > 0) flush();
		buf.push(line);
		size += line.length + 1;
	}
	flush();
	if (!out.length) out.push([n.title, n.tags.map((t) => `#${t}`).join(" ")].filter(Boolean).join("\n"));
	return out.slice(0, MAX_PASSAGES);
}
