// build_context and session context, ported from internal/memory/context.go.

import { summary } from "../engine/notes";
import type { Hit, LinkHit, Store } from "./store";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function buildContext(store: Store, path: string, depth: number): string {
	const r = store.read(path)!;
	const { hits: out, missing } = store.outgoing(path);
	const back = store.backlinks(path);
	let b = `# ${r.note.title}\npath: ${path} · modified ${day(r.updated)}\n\n${r.note.body.trim()}\n`;
	const line = (h: LinkHit) => {
		const s = noteSummary(store, h.path);
		return `- ${h.relation ? h.relation + " " : ""}[[${h.title}]] (${h.path})${s ? ": " + s : ""}\n`;
	};
	if (out.length) b += "\n## Links to\n" + out.map(line).join("");
	if (back.length) b += "\n## Linked from\n" + back.map(line).join("");
	if (missing.length) b += "\n## Links to notes that don't exist yet\n" + missing.map((m) => `- [[${m}]]\n`).join("");
	if (depth >= 2) {
		const seen = new Set([path, ...out.map((h) => h.path), ...back.map((h) => h.path)]);
		const lines: string[] = [];
		for (const h of [...out, ...back]) {
			for (const far of [...store.outgoing(h.path).hits, ...store.backlinks(h.path)]) {
				if (seen.has(far.path)) continue;
				seen.add(far.path);
				lines.push(`- [[${far.title}]] (${far.path}), via [[${h.title}]]\n`);
			}
		}
		if (lines.length) {
			b += "\n## Two links away\n" + lines.slice(0, 20).join("");
			if (lines.length > 20) b += `- … and ${lines.length - 20} more\n`;
		}
	}
	if (out.length + back.length + missing.length === 0) b += "\nThis note has no links yet. Link related notes with [[Title]].\n";
	return b;
}

function noteSummary(store: Store, path: string): string {
	const r = store.read(path);
	return r ? summary(r.note.body) : "";
}

const MAX_NOTE_CHARS = 1500;

// sessionContext renders pinned notes in full, then a one-line index of the
// project's notes, general notes and recent activity, within roughly budget
// characters.
export function sessionContext(store: Store, project: string, budget: number): string {
	const byNewest = (hits: Hit[]) => hits.sort((a, b) => b.updated - a.updated);
	const projectNotes = project ? byNewest(store.list(project)) : [];
	const general = byNewest(store.list("general"));
	const recent = store.recent(20);

	let b = "# Memory (memory-go)\n\n";
	b +=
		"Persistent notes shared across the user's machines and AI apps. Below: pinned notes in full, then an index of other notes; " +
		"open them with read_note or build_context when relevant, and use search_notes for anything else.\n";
	if (project) b += `Current project: "${project}". Save project-specific notes in directory "${project}"; cross-project ones in "general".\n`;
	if (projectNotes.length + general.length + recent.length === 0) return b + "\nMemory is empty so far.\n";

	const shown = new Set<string>();
	let pinnedHeading = false;
	for (const h of [...projectNotes, ...general]) {
		if (!h.pinned) continue;
		const r = store.read(h.path);
		if (!r) continue;
		let body = r.note.body.trim();
		if ([...body].length > MAX_NOTE_CHARS) body = [...body].slice(0, MAX_NOTE_CHARS).join("") + `\n… (truncated; read_note ${h.path} for the rest)`;
		const entry = `\n### ${r.note.title} (${h.path})\n${body}\n`;
		if (b.length + entry.length > (budget * 6) / 10) continue;
		if (!pinnedHeading) {
			b += "\n## Pinned notes\n";
			pinnedHeading = true;
		}
		b += entry;
		shown.add(h.path);
	}

	const index = (heading: string, hits: Hit[], more: string) => {
		let left = 0;
		let wrote = false;
		for (const h of hits) {
			if (shown.has(h.path)) continue;
			if (!wrote) {
				b += heading;
				wrote = true;
			}
			const line = `- ${h.title} (${h.path}, ${day(h.updated)})${h.pinned ? " [pinned]" : ""}${h.summary ? ": " + h.summary : ""}\n`;
			if (left > 0 || b.length + line.length > budget) {
				left++;
				continue;
			}
			b += line;
			shown.add(h.path);
		}
		if (left > 0) b += `- … and ${left} more (${more})\n`;
	};
	if (project) {
		const heading = `\n## Project notes (${project})\n`;
		if (!projectNotes.length) b += heading + "None yet.\n";
		index(heading, projectNotes, `list_notes directory "${project}"`);
	}
	index("\n## General notes\n", general, `list_notes directory "general"`);
	const others = recent.filter((h) => !shown.has(h.path) && !h.path.startsWith(project + "/")).slice(0, 5);
	index("\n## Recently updated elsewhere\n", others, "recent_activity");
	return b;
}

