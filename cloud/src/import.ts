// Turns chat exports and Markdown folders into notes.
//
// - Claude (claude.ai → Settings → Export data): conversations.json, an array
//   of { name, created_at, chat_messages: [{ sender, text | content[] }] }.
// - ChatGPT (Settings → Data controls → Export): conversations.json, an array
//   of { title, create_time, mapping: { id: { message, parent } }, current_node }.
// - A zip of Markdown files (Basic Memory, Obsidian, memory-go): kept as-is.

import { unzipSync } from "fflate";
import { type Note, format, slugify } from "./engine/notes";

export interface ImportResult {
	source: "claude" | "chatgpt" | "markdown";
	files: { path: string; content: string }[];
}

// Per-message and per-note caps keep a huge conversation from flooding the
// search index; the note says where it was cut.
const MAX_MESSAGE = 4000;
const MAX_NOTE = 60_000;

export function parseExport(name: string, data: Uint8Array): ImportResult {
	const files: Record<string, Uint8Array> = name.toLowerCase().endsWith(".json") ? { "conversations.json": data } : unzipSync(data);
	const convKey = Object.keys(files).find((k) => k.split("/").pop() === "conversations.json");
	if (convKey) {
		const conversations = JSON.parse(new TextDecoder().decode(files[convKey]));
		if (!Array.isArray(conversations)) throw new Error("conversations.json is not a list of conversations");
		if (conversations.some((c) => c && "mapping" in c)) return { source: "chatgpt", files: unique(conversations.map(chatgpt).filter(nonEmpty)) };
		return { source: "claude", files: unique(conversations.map(claude).filter(nonEmpty)) };
	}
	const md = Object.entries(files).filter(([p]) => p.endsWith(".md") && !p.split("/").some((s) => s.startsWith(".") || s === "__MACOSX"));
	if (!md.length) throw new Error("no conversations.json and no Markdown files in this file");
	const prefix = commonDir(md.map(([p]) => p));
	return {
		source: "markdown",
		files: md.map(([p, bytes]) => ({ path: p.slice(prefix.length), content: new TextDecoder().decode(bytes) })),
	};
}

// unique gives same-day conversations with the same title distinct paths.
function unique(files: { path: string; content: string }[]) {
	const used = new Set<string>();
	return files.map((f) => {
		let path = f.path;
		for (let i = 2; used.has(path); i++) path = f.path.replace(/\.md$/, `-${i}.md`);
		used.add(path);
		return { ...f, path };
	});
}

const nonEmpty = (f: { path: string; content: string } | null): f is { path: string; content: string } => f !== null;

type Turn = { who: string; text: string; at?: string };

function claude(c: {
	name?: string;
	created_at?: string;
	chat_messages?: { sender?: string; text?: string; content?: { type?: string; text?: string }[]; created_at?: string }[];
}): { path: string; content: string } | null {
	const turns: Turn[] = (c.chat_messages ?? []).map((m) => ({
		who: m.sender === "human" ? "User" : "Claude",
		text: m.text || (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n\n"),
		at: m.created_at,
	}));
	return conversationNote("claude", "Claude", c.name || "Untitled conversation", c.created_at, turns);
}

function chatgpt(c: {
	title?: string;
	create_time?: number;
	current_node?: string;
	mapping?: Record<string, { parent?: string | null; message?: { author?: { role?: string }; content?: { content_type?: string; parts?: unknown[] }; create_time?: number } | null }>;
}): { path: string; content: string } | null {
	const mapping = c.mapping ?? {};
	// Follow the branch the user last saw, from its leaf back to the root.
	const chain: string[] = [];
	for (let id = c.current_node; id && mapping[id] && chain.length < 10_000; id = mapping[id].parent ?? undefined) chain.push(id);
	const turns: Turn[] = [];
	for (const id of chain.reverse()) {
		const m = mapping[id].message;
		const role = m?.author?.role;
		if (!m || (role !== "user" && role !== "assistant")) continue;
		if (m.content?.content_type && m.content.content_type !== "text") continue;
		const text = (m.content?.parts ?? []).filter((p): p is string => typeof p === "string").join("\n\n");
		if (text.trim()) turns.push({ who: role === "user" ? "User" : "ChatGPT", text });
	}
	const created = c.create_time ? new Date(c.create_time * 1000).toISOString() : undefined;
	return conversationNote("chatgpt", "ChatGPT", c.title || "Untitled conversation", created, turns);
}

function conversationNote(source: string, app: string, title: string, created: string | undefined, turns: Turn[]): { path: string; content: string } | null {
	turns = turns.filter((t) => t.text.trim());
	if (!turns.length) return null;
	const date = created && !Number.isNaN(Date.parse(created)) ? new Date(created) : null;
	const day = date ? date.toISOString().slice(0, 10) : "undated";
	let body = `Conversation imported from ${app}${date ? `, started ${day}` : ""}. ${turns.length} messages.\n`;
	let truncated = false;
	for (const t of turns) {
		let text = t.text.trim();
		if (text.length > MAX_MESSAGE) text = text.slice(0, MAX_MESSAGE) + "\n\n… (message truncated)";
		const part = `\n### ${t.who}\n\n${text}\n`;
		if (body.length + part.length > MAX_NOTE) {
			truncated = true;
			break;
		}
		body += part;
	}
	if (truncated) body += "\n… (conversation truncated)\n";
	const note: Note = {
		path: `imports/${source}/${day}-${slugify(title)}.md`,
		title: `${title} (${day})`,
		tags: ["import", source],
		created: date ? date.toISOString().replace(/\.\d{3}Z$/, "Z") : null,
		pinned: false,
		locked: false,
		extra: [],
		body,
	};
	return { path: note.path, content: format(note) };
}

function commonDir(paths: string[]): string {
	const dirs = paths.map((p) => p.split("/").slice(0, -1));
	if (!dirs.length) return "";
	const first = dirs[0];
	let n = first.length;
	for (const d of dirs) {
		let i = 0;
		while (i < n && i < d.length && d[i] === first[i]) i++;
		n = i;
	}
	return n ? first.slice(0, n).join("/") + "/" : "";
}
