// The command palette (⌘K): jump to a note by title as you type, search
// note contents on the server, or run a command.

import { CornerDownLeft, FileText, Network, Plus, Search as SearchIcon, Settings, Plug, Home, Upload } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { newNote } from "./App";
import { type Hit, type Workspace, api } from "./api";
import { dirOf } from "./notes";
import { navigate, noteUrl, wsUrl } from "./router";
import { patchNotes, prefetch, toast, useStore } from "./store";

interface Item {
	key: string;
	icon: ReactNode;
	label: string;
	detail?: string;
	run: () => void;
	path?: string;
}

// score ranks a title against the query: prefix, word start, then any
// in-order subsequence (so "gmd" finds "gitmind design").
function score(title: string, q: string): number {
	const t = title.toLowerCase();
	if (t.startsWith(q)) return 100 - t.length / 100;
	const i = t.indexOf(q);
	if (i > 0 && /\W/.test(t[i - 1])) return 80 - i / 100;
	if (i >= 0) return 60 - i / 100;
	let j = 0;
	for (const c of t) if (c === q[j]) j++;
	return j === q.length ? 20 : -1;
}

export function Palette({ ws, onClose, initial = "" }: { ws: Workspace; onClose: () => void; initial?: string }) {
	const notes = useStore((s) => s.notes[ws.slug]) ?? [];
	const [q, setQ] = useState(initial);
	const [sel, setSel] = useState(0);
	const [hits, setHits] = useState<Hit[]>([]);
	const list = useRef<HTMLDivElement>(null);

	// Full-text search on the server, a moment after typing stops.
	useEffect(() => {
		const query = q.trim();
		if (query.length < 2) return setHits([]);
		const t = setTimeout(() => api.search(ws.slug, query, 10).then(setHits, () => {}), 180);
		return () => clearTimeout(t);
	}, [q, ws.slug]);

	const items = useMemo<Item[]>(() => {
		const query = q.trim().toLowerCase();
		const go = (href: string) => () => {
			navigate(href);
			onClose();
		};
		const commands: Item[] = [
			{ key: "new", icon: <Plus size={15} />, label: query ? `New note "${q.trim()}"` : "New note", run: () => (onClose(), query ? createTitled(ws.slug, q.trim()) : newNote(ws.slug, "")) },
			{ key: "home", icon: <Home size={15} />, label: "Go to Home", run: go(wsUrl(ws.slug)) },
			{ key: "graph", icon: <Network size={15} />, label: "Open graph", run: go(wsUrl(ws.slug, "graph")) },
			{ key: "settings", icon: <Settings size={15} />, label: "Settings", run: go(wsUrl(ws.slug, "settings")) },
			{ key: "connect", icon: <Plug size={15} />, label: "Connect AI apps", run: go(wsUrl(ws.slug, "settings") + "#connect") },
			{ key: "import", icon: <Upload size={15} />, label: "Import chats or notes", run: go(wsUrl(ws.slug, "settings") + "#import") },
		];
		const byTitle = query
			? notes
					.map((n) => ({ n, s: Math.max(score(n.title, query), score(n.path, query) - 30) }))
					.filter((x) => x.s >= 0)
					.sort((a, b) => b.s - a.s)
					.slice(0, 12)
					.map((x) => x.n)
			: [...notes].sort((a, b) => b.updated - a.updated).slice(0, 8);
		const seen = new Set(byTitle.map((n) => n.path));
		const content = hits.filter((h) => !seen.has(h.path));
		const noteItem = (n: Hit, detail?: string): Item => ({
			key: "n:" + n.path,
			icon: <FileText size={15} />,
			label: n.title,
			detail: detail ?? (dirOf(n.path) || undefined),
			run: go(noteUrl(ws.slug, n.path)),
			path: n.path,
		});
		const matchingCommands = query ? commands.filter((c) => c.key === "new" || c.label.toLowerCase().includes(query)) : commands.slice(0, 1);
		return [
			...byTitle.map((n) => noteItem(n)),
			...content.map((h) => noteItem(h, (h.snippet || h.summary).replace(/\*\*/g, "").slice(0, 90))),
			...matchingCommands,
		];
	}, [q, notes, hits, ws.slug]);

	useEffect(() => setSel(0), [q]);
	useEffect(() => {
		const p = items[sel]?.path;
		if (p) prefetch(ws.slug, p);
		list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
	}, [sel, items]);

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-4 pt-[12vh]" onMouseDown={onClose}>
			<div className="w-full max-w-[600px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
				<div className="flex items-center gap-2 border-b border-line px-3.5">
					<SearchIcon size={16} className="text-muted" />
					<input
						autoFocus
						className="w-full bg-transparent py-3 text-[15px] outline-none placeholder:text-muted"
						placeholder="Find a note, or type a command…"
						value={q}
						onChange={(e) => setQ(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") onClose();
							else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
								e.preventDefault();
								setSel((s) => Math.min(items.length - 1, s + 1));
							} else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
								e.preventDefault();
								setSel((s) => Math.max(0, s - 1));
							} else if (e.key === "Enter") {
								e.preventDefault();
								items[sel]?.run();
							}
						}}
					/>
				</div>
				<div ref={list} className="max-h-[50vh] overflow-y-auto p-1.5">
					{items.map((it, i) => (
						<button
							key={it.key}
							data-i={i}
							className={`flex w-full items-center gap-2.5 rounded-[3px] px-2.5 py-2 text-left text-[14px] ${i === sel ? "bg-accent-soft" : ""}`}
							onMouseMove={() => setSel(i)}
							onClick={() => it.run()}
						>
							<span className="text-muted">{it.icon}</span>
							<span className="shrink-0 truncate">{it.label}</span>
							{it.detail && <span className="min-w-0 truncate text-[12.5px] text-muted">{it.detail}</span>}
							{i === sel && <CornerDownLeft size={13} className="ml-auto shrink-0 text-muted" />}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

async function createTitled(slug: string, title: string) {
	try {
		const r = await api.create(slug, title, "");
		patchNotes(slug, (ns) => [...ns, { path: r.path, title, tags: [], updated: Date.now(), summary: "", pinned: false, snippet: "" }]);
		navigate(noteUrl(slug, r.path));
	} catch (e) {
		toast((e as Error).message, true);
	}
}
