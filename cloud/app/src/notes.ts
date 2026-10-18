// Helpers over the note list: the folder tree, link resolution and titles.

import type { Hit } from "./api";
import { linkTarget } from "../../src/engine/notes";

export interface Folder {
	name: string;
	path: string; // "" for the top level
	folders: Folder[];
	notes: Hit[];
}

export function tree(notes: Hit[]): Folder {
	const root: Folder = { name: "", path: "", folders: [], notes: [] };
	for (const n of notes) {
		const parts = n.path.split("/");
		let f = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const path = parts.slice(0, i + 1).join("/");
			let sub = f.folders.find((x) => x.path === path);
			if (!sub) {
				sub = { name: parts[i], path, folders: [], notes: [] };
				f.folders.push(sub);
			}
			f = sub;
		}
		f.notes.push(n);
	}
	const sort = (f: Folder) => {
		f.folders.sort((a, b) => a.name.localeCompare(b.name));
		f.notes.sort((a, b) => a.title.localeCompare(b.title));
		f.folders.forEach(sort);
	};
	sort(root);
	return root;
}

// resolver maps a [[link]] target to a note path, the way the server does:
// by path when it has a slash, otherwise by slugified title or file name.
export function resolver(notes: Hit[]): (target: string) => string | null {
	const paths = new Set(notes.map((n) => n.path));
	const bySlug = new Map<string, string>();
	for (const n of notes) {
		bySlug.set(linkTarget(n.path.slice(n.path.lastIndexOf("/") + 1)).slug, n.path);
		bySlug.set(linkTarget(n.title).slug, n.path);
	}
	return (target) => {
		const t = linkTarget(target);
		if (t.notePath) return paths.has(t.notePath) ? t.notePath : null;
		return bySlug.get(t.slug) ?? null;
	};
}

export const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export function uniqueTitle(notes: Hit[], dir: string, base = "Untitled"): string {
	const taken = new Set(notes.filter((n) => dirOf(n.path) === dir).map((n) => n.title.toLowerCase()));
	if (!taken.has(base.toLowerCase())) return base;
	for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

export function ago(ms: number): string {
	const s = (Date.now() - ms) / 1000;
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
	return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
