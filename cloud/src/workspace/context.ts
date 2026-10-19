// build_context and session context, ported from internal/memory/context.go.

import { currentObservations, summary } from "../engine/notes";
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

// Caps besides the size budget: profile facts, and index lines per section.
const MAX_PROFILE_FACTS = 40;
const MAX_PROJECT_LINES = 40;
const MAX_GENERAL_LINES = 20;
const MAX_OTHER_LINES = 5;

export interface ProfileFact {
	category: "instruction" | "preference";
	text: string;
	title: string;
	path: string;
}

// profile gathers the user's standing instructions and preferences: the
// [instruction] and [preference] facts of the notes in general/ and the
// project's notes, newest notes first, instructions before preferences.
// Facts under a "History" heading, notes in skip and repeats are left out.
// A port of App.Profile (internal/memory/context.go).
export function profile(store: Store, project: string, skip: Set<string> = new Set()): ProfileFact[] {
	const dirs = project && project !== "general" ? ["general", project] : ["general"];
	const hits = dirs.flatMap((d) => store.list(d)).sort((a, b) => b.updated - a.updated);
	const seen = new Set<string>();
	const facts: ProfileFact[] = [];
	for (const h of hits) {
		if (skip.has(h.path)) continue;
		const r = store.read(h.path);
		if (!r) continue;
		for (const o of currentObservations(r.note.body)) {
			if (o.category !== "instruction" && o.category !== "preference") continue;
			const text = o.text.replace(/(\s+#[\p{L}\p{N}_/-]+)+\s*$/u, "").trim();
			const key = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
			if (!text || seen.has(key)) continue;
			seen.add(key);
			facts.push({ category: o.category, text, title: r.note.title, path: h.path });
		}
	}
	return facts.sort((a, b) => (a.category === b.category ? 0 : a.category === "instruction" ? -1 : 1));
}

// sessionContext renders pinned notes in full, then a one-line index of the
// project's notes, general notes and recent activity, within roughly budget
// characters.
// handoffPath is where a project's handoff lives: one note per project,
// replaced by each session that stops with work unfinished.
export const handoffPath = (project: string) => `${project}/handoff.md`;

export function sessionContext(store: Store, project: string, budget: number): string {
	const byNewest = (hits: Hit[]) => hits.sort((a, b) => b.updated - a.updated);
	const projectNotes = project ? byNewest(store.list(project)) : [];
	const general = byNewest(store.list("general"));
	const recent = store.recent(20);

	let b = "# Memory (gitmind)\n\n";
	b +=
		"Persistent notes shared across the user's machines and AI apps. Below: pinned notes in full, then an index of other notes; " +
		"open them with read_note or build_context when relevant, and use search_notes for anything else.\n";
	if (project) b += `Current project: "${project}". Save project-specific notes in directory "${project}"; cross-project ones in "general".\n`;
	if (projectNotes.length + general.length + recent.length === 0) return b + "\nMemory is empty so far.\n";

	// The profile first, within a quarter of the budget; pinned notes are
	// shown in full below, so their facts are skipped here.
	const pinned = new Set([...projectNotes, ...general].filter((h) => h.pinned).map((h) => h.path));
	const facts = profile(store, project, pinned);
	if (facts.length) {
		b += "\n## Profile: how the user works\n";
		b +=
			"Standing instructions and preferences from the notes, newest first. They're defaults: the user's current " +
			"instructions and the repository's own rules (CLAUDE.md, AGENTS.md) come first. When a choice rests on one of these, " +
			"say so briefly so the user can correct it.\n";
		let left = 0;
		facts.forEach((f, i) => {
			const line = `- [${f.category}] ${f.text} (${f.title})\n`;
			if (left > 0 || i >= MAX_PROFILE_FACTS || b.length + line.length > budget / 4) left++;
			else b += line;
		});
		if (left > 0) b += `- … and ${left} more (search_notes category "instruction" or "preference")\n`;
	}

	const shown = new Set<string>();
	// The project's handoff: where the last session left off, in full.
	const handoff = project ? store.read(handoffPath(project)) : null;
	if (handoff) {
		let body = handoff.note.body.trim();
		if ([...body].length > MAX_NOTE_CHARS) body = [...body].slice(0, MAX_NOTE_CHARS).join("") + `\n… (truncated; read_note ${handoffPath(project)} for the rest)`;
		b += `\n## Where we left off (${new Date(handoff.updated).toISOString().slice(0, 10)})\n`;
		b +=
			"The last session's handoff. When the user asks to continue, start from it. When you stop with work unfinished, " +
			"replace it with handoff; when the work is done, clear it (handoff with empty content).\n\n";
		b += body + "\n";
		shown.add(handoffPath(project));
	}

	// Pinned notes fill up to three quarters of the budget.
	let pinnedHeading = false;
	for (const h of [...projectNotes, ...general]) {
		if (!h.pinned) continue;
		const r = store.read(h.path);
		if (!r) continue;
		let body = r.note.body.trim();
		if ([...body].length > MAX_NOTE_CHARS) body = [...body].slice(0, MAX_NOTE_CHARS).join("") + `\n… (truncated; read_note ${h.path} for the rest)`;
		const entry = `\n### ${r.note.title} (${h.path})\n${body}\n`;
		if (b.length + entry.length > (budget * 3) / 4) continue;
		if (!pinnedHeading) {
			b += "\n## Pinned notes\n";
			pinnedHeading = true;
		}
		b += entry;
		shown.add(h.path);
	}

	const index = (heading: string, hits: Hit[], maxLines: number, more: string) => {
		let left = 0;
		let lines = 0;
		let wrote = false;
		for (const h of hits) {
			if (shown.has(h.path)) continue;
			if (!wrote) {
				b += heading;
				wrote = true;
			}
			const line = `- ${h.title} (${h.path}, ${day(h.updated)})${h.pinned ? " [pinned]" : ""}${h.summary ? ": " + h.summary : ""}\n`;
			if (left > 0 || lines >= maxLines || b.length + line.length > budget) {
				left++;
				continue;
			}
			b += line;
			lines++;
			shown.add(h.path);
		}
		if (left > 0) b += `- … and ${left} more (${more})\n`;
	};
	if (project) {
		const heading = `\n## Project notes (${project})\n`;
		if (!projectNotes.length) b += heading + "None yet.\n";
		index(heading, projectNotes, MAX_PROJECT_LINES, `list_notes directory "${project}"`);
	}
	index("\n## General notes\n", general, MAX_GENERAL_LINES, `list_notes directory "general"`);
	const others = recent.filter((h) => !shown.has(h.path) && !h.path.startsWith(project + "/")).slice(0, 5);
	index("\n## Recently updated elsewhere\n", others, MAX_OTHER_LINES, "recent_activity");
	return b;
}

