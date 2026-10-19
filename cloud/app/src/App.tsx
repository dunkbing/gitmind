// The app shell: sidebar (workspace, navigation, pinned notes, the folder
// tree), the current view, the command palette and toasts.

import { ChevronDown, ChevronRight, FileText, BookOpen, Folder as FolderIcon, Home, Inbox, Menu, Moon, Network, Pin, Plus, Search, Settings, Sun, X } from "lucide-react";
import { type ReactNode, Suspense, lazy, useEffect, useMemo, useState } from "react";
import type { Hit, Workspace } from "./api";
import { api } from "./api";
import { Palette } from "./Palette";
import { Link, navigate, noteUrl, parseRoute, type Route, useLocation, wsUrl } from "./router";
import { loadInboxCount, loadMe, loadNotes, patchNotes, prefetch, toast, useStore } from "./store";
import { type Folder, tree, uniqueTitle } from "./notes";
import { ConnectView } from "./views/Connect";
import { HomeView } from "./views/Home";
import { InboxView } from "./views/Inbox";
import { SettingsView } from "./views/Settings";

// The editor (CodeMirror) and graph load on first use, keeping the first
// paint small.
const NoteView = lazy(() => import("./views/Note").then((m) => ({ default: m.NoteView })));
const GraphView = lazy(() => import("./views/Graph").then((m) => ({ default: m.GraphView })));

const PALETTE_EVENT = "gm-palette";

// openPalette opens the ⌘K palette with a query, e.g. "#tag" from a tag link.
export const openPalette = (query = "") => dispatchEvent(new CustomEvent(PALETTE_EVENT, { detail: query }));

export function App() {
	const me = useStore((s) => s.me);
	const url = useLocation();
	const route = parseRoute(url);
	const [error, setError] = useState("");
	// The palette's starting query while it's open, null when closed.
	const [palette, setPalette] = useState<string | null>(null);
	const [drawer, setDrawer] = useState(false);

	useEffect(() => {
		loadMe().catch((e) => setError(e.message));
		// Fetch the editor in the background so the first note opens at once.
		const idle = setTimeout(() => import("./views/Note"), 1500);
		return () => clearTimeout(idle);
	}, []);

	// Close the mobile drawer whenever the view changes.
	useEffect(() => setDrawer(false), [url.pathname]);

	const slug = "slug" in route ? route.slug : undefined;
	const ws = me?.workspaces.find((w) => w.slug === slug) ?? (route.view === "connect" ? me?.workspaces[0] : undefined);

	useEffect(() => {
		if (!ws) return;
		loadNotes(ws.slug).catch((e) => toast(e.message, true));
		loadInboxCount(ws.slug).catch(() => {});
	}, [ws?.slug]);

	// Pick up changes made elsewhere (agents, other devices) when coming back.
	useEffect(() => {
		const onFocus = () => {
			if (!ws) return;
			loadNotes(ws.slug, true).catch(() => {});
			loadInboxCount(ws.slug).catch(() => {});
		};
		addEventListener("focus", onFocus);
		return () => removeEventListener("focus", onFocus);
	}, [ws?.slug]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			if (mod && (e.key === "k" || e.key === "p" || e.key === "o")) {
				e.preventDefault();
				setPalette((p) => (p === null ? "" : null));
			}
			if (mod && e.altKey && e.key.toLowerCase() === "n" && ws) {
				e.preventDefault();
				newNote(ws.slug, "");
			}
		};
		const onOpen = (e: Event) => setPalette((e as CustomEvent<string>).detail);
		addEventListener("keydown", onKey);
		addEventListener(PALETTE_EVENT, onOpen);
		return () => {
			removeEventListener("keydown", onKey);
			removeEventListener(PALETTE_EVENT, onOpen);
		};
	}, [ws?.slug]);

	if (error) return <Centered>{error}</Centered>;
	if (!me) return <Centered><span className="animate-pulse text-muted">Loading…</span></Centered>;
	// /connect (linked from sign-in pages) is a section of Settings now.
	if (route.view === "connect" && me.workspaces[0]) {
		navigate(wsUrl(me.workspaces[0].slug, "settings") + "#connect", { replace: true });
		return null;
	}
	if (!ws && route.view !== "connect") {
		const home = me.workspaces[0];
		if (home) navigate(wsUrl(home.slug), { replace: true });
		else return <Centered>No such workspace, or you're not a member.</Centered>;
		return null;
	}

	return (
		<div className="flex h-full">
			<aside
				className={`fixed inset-y-0 left-0 z-30 flex w-[260px] shrink-0 flex-col border-r border-line bg-paper transition-transform md:static md:translate-x-0 ${drawer ? "translate-x-0 shadow-2xl" : "-translate-x-full"}`}
			>
				<Sidebar ws={ws!} workspaces={me.workspaces} route={route} openPalette={() => setPalette("")} />
			</aside>
			{drawer && <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={() => setDrawer(false)} />}
			<main className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<div className="flex items-center gap-2 border-b border-line px-3 py-2 md:hidden">
					<button className="btn-ghost" onClick={() => setDrawer(true)} aria-label="Menu">
						<Menu size={18} />
					</button>
					<span className="truncate text-[14px]">{ws?.name}</span>
					<button className="btn-ghost ml-auto" onClick={() => setPalette("")} aria-label="Search">
						<Search size={18} />
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto" id="scroller">
					<Suspense fallback={null}>
						<View route={route} ws={ws!} />
					</Suspense>
				</div>
			</main>
			{palette !== null && ws && <Palette ws={ws} initial={palette} onClose={() => setPalette(null)} />}
			<Toasts />
		</div>
	);
}

function View({ route, ws }: { route: Route; ws: Workspace }) {
	switch (route.view) {
		case "home":
			return <HomeView ws={ws} />;
		case "note":
			return <NoteView ws={ws} path={route.path} />;
		case "graph":
			return <GraphView ws={ws} />;
		case "inbox":
			return <InboxView ws={ws} />;
		case "settings":
			return <SettingsView ws={ws} />;
		case "connect":
			return <ConnectView />;
		default:
			return <Centered>This page doesn't exist.</Centered>;
	}
}

const Centered = ({ children }: { children: ReactNode }) => <div className="flex h-full items-center justify-center p-8 text-center text-[15px]">{children}</div>;

// newNote creates an untitled note in dir and opens it, title selected.
export async function newNote(slug: string, dir: string) {
	const notes = await loadNotes(slug);
	const title = uniqueTitle(notes, dir);
	try {
		const r = await api.create(slug, title, dir);
		patchNotes(slug, (ns) => [...ns, { path: r.path, title, tags: [], updated: Date.now(), summary: "", pinned: false, snippet: "" }]);
		navigate(noteUrl(slug, r.path) + "?new=1");
		loadNotes(slug, true).catch(() => {});
	} catch (e) {
		toast((e as Error).message, true);
	}
}

const LOGO = (
	<svg viewBox="0 0 512 512" width="20" height="20" aria-hidden="true" className="shrink-0 text-accent">
		<g fill="none" stroke="currentColor" strokeLinecap="round">
			<path d="M176 112 V346" strokeWidth="44" />
			<path d="M176 300 C176 210 336 244 336 150" strokeWidth="44" />
			<circle cx="176" cy="404" r="48" strokeWidth="40" />
		</g>
		<g fill="currentColor">
			<circle cx="176" cy="104" r="58" />
			<circle cx="336" cy="134" r="58" />
		</g>
	</svg>
);

function Sidebar({ ws, workspaces, route, openPalette }: { ws: Workspace; workspaces: Workspace[]; route: Route; openPalette: () => void }) {
	const me = useStore((s) => s.me)!;
	const notes = useStore((s) => s.notes[ws.slug]);
	const root = useMemo(() => tree(notes ?? []), [notes]);
	const pinned = useMemo(() => (notes ?? []).filter((n) => n.pinned), [notes]);
	const [switcher, setSwitcher] = useState(false);
	const mac = /Mac|iPhone|iPad/.test(navigator.platform);
	const pending = useStore((s) => s.inbox[ws.slug]) ?? 0;
	const item = (view: Route["view"], href: string, icon: ReactNode, label: string, badge = 0) => (
		<Link
			href={href}
			className={`flex items-center gap-2.5 rounded-md px-2 py-1 text-[13.5px] no-underline ${route.view === view ? "bg-accent-soft text-ink" : "text-muted hover:bg-accent-soft/60 hover:text-ink"}`}
		>
			{icon}
			{label}
			{badge > 0 && <span className="ml-auto rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-medium text-accent-ink">{badge}</span>}
		</Link>
	);
	return (
		<div className="flex h-full flex-col">
			<div className="relative px-2 pt-3">
				<button className="flex w-full items-center gap-2 rounded-[3px] px-2 py-1.5 text-left hover:bg-accent-soft/60" onClick={() => setSwitcher((s) => !s)}>
					{LOGO}
					<span className="min-w-0 flex-1 truncate text-[14px] font-medium">{ws.name}</span>
					<ChevronDown size={14} className="text-muted" />
				</button>
				{switcher && (
					<div className="absolute inset-x-2 top-full z-40 mt-1 rounded-lg border border-line bg-surface p-1 shadow-xl" onMouseLeave={() => setSwitcher(false)}>
						{workspaces.map((w) => (
							<Link
								key={w.id}
								href={wsUrl(w.slug)}
								onClick={() => setSwitcher(false)}
								className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[13.5px] text-ink no-underline hover:bg-accent-soft ${w.id === ws.id ? "bg-accent-soft/60" : ""}`}
							>
								<span className="truncate">{w.name}</span>
								<span className="text-[11px] text-muted">{w.kind === "team" ? "team" : "personal"}</span>
							</Link>
						))}
						<NewTeam onDone={() => setSwitcher(false)} />
					</div>
				)}
			</div>

			<div className="flex gap-1 px-3 pt-2">
				<button className="flex flex-1 items-center gap-2 rounded-[3px] bg-ink/[0.06] px-2 py-1 text-[13px] text-muted hover:bg-ink/[0.11] hover:text-ink" onClick={openPalette}>
					<Search size={14} />
					Search
					<kbd className="ml-auto font-sans text-[11px] opacity-70">{mac ? "⌘K" : "Ctrl K"}</kbd>
				</button>
				<button className="btn-ghost px-1.5" title="New note" onClick={() => newNote(ws.slug, "")}>
					<Plus size={16} />
				</button>
			</div>

			<nav className="flex flex-col gap-px px-2 pt-3">
				{item("home", wsUrl(ws.slug), <Home size={15} />, "Home")}
				{item("inbox", wsUrl(ws.slug, "inbox"), <Inbox size={15} />, "Inbox", pending)}
				{item("graph", wsUrl(ws.slug, "graph"), <Network size={15} />, "Graph")}
				{item("settings", wsUrl(ws.slug, "settings"), <Settings size={15} />, "Settings")}
			</nav>

			<div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
				{pinned.length > 0 && (
					<>
						<div className="label px-2 pt-2 pb-1">Pinned</div>
						{pinned.map((n) => (
							<NoteItem key={n.path} n={n} ws={ws} route={route} depth={0} icon={<Pin size={13} />} />
						))}
					</>
				)}
				<div className="label flex items-center justify-between px-2 pt-3 pb-1">
					Notes
					<span className="font-normal normal-case tracking-normal">{notes?.length ?? ""}</span>
				</div>
				{notes === undefined ? (
					<div className="px-2 text-[13px] text-muted">Loading…</div>
				) : notes.length === 0 ? (
					<div className="px-2 text-[13px] text-muted">No notes yet.</div>
				) : (
					<FolderItems f={root} ws={ws} route={route} depth={0} />
				)}
			</div>

			<div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
				{me.user.avatar_url && <img src={me.user.avatar_url} alt="" className="size-6 rounded-full" />}
				<span className="min-w-0 flex-1 truncate text-[13px]">{me.user.login}</span>
				<ThemeToggle />
				<a className="btn-ghost px-1.5" href="/docs/" title="Documentation">
					<BookOpen size={15} />
				</a>
				<form method="post" action="/logout">
					<button className="btn-ghost px-1.5 text-[12px]" title="Sign out">
						Sign out
					</button>
				</form>
			</div>
		</div>
	);
}

function NewTeam({ onDone }: { onDone: () => void }) {
	const [name, setName] = useState("");
	const [open, setOpen] = useState(false);
	if (!open)
		return (
			<button className="mt-1 flex w-full items-center gap-2 rounded-[3px] border-t border-line px-2 py-1.5 text-[13px] text-muted hover:text-ink" onClick={() => setOpen(true)}>
				<Plus size={13} /> New team workspace
			</button>
		);
	return (
		<form
			className="mt-1 flex gap-1 border-t border-line p-1 pt-2"
			onSubmit={async (e) => {
				e.preventDefault();
				try {
					const w = await api.createTeam(name);
					await loadMe();
					onDone();
					navigate(wsUrl(w.slug, "settings"));
				} catch (err) {
					toast((err as Error).message, true);
				}
			}}
		>
			<input className="field py-1 text-[13px]" autoFocus placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} />
			<button className="btn py-1">Create</button>
		</form>
	);
}

const openFolders = (): Set<string> => {
	try {
		return new Set(JSON.parse(localStorage.getItem("gm-closed") ?? "[]"));
	} catch {
		return new Set();
	}
};

function FolderItems({ f, ws, route, depth }: { f: Folder; ws: Workspace; route: Route; depth: number }) {
	return (
		<>
			{f.folders.map((sub) => (
				<FolderRow key={sub.path} f={sub} ws={ws} route={route} depth={depth} />
			))}
			{f.notes.map((n) => (
				<NoteItem key={n.path} n={n} ws={ws} route={route} depth={depth} />
			))}
		</>
	);
}

function FolderRow({ f, ws, route, depth }: { f: Folder; ws: Workspace; route: Route; depth: number }) {
	const [closed, setClosed] = useState(() => openFolders().has(`${ws.slug}:${f.path}`));
	const toggle = () => {
		setClosed((c) => {
			const all = openFolders();
			const k = `${ws.slug}:${f.path}`;
			if (c) all.delete(k);
			else all.add(k);
			try {
				localStorage.setItem("gm-closed", JSON.stringify([...all]));
			} catch {}
			return !c;
		});
	};
	return (
		<div>
			<div className="group flex items-center rounded-md hover:bg-accent-soft/60" style={{ paddingLeft: depth * 12 }}>
				<button className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-[13.5px] text-muted" onClick={toggle}>
					{closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
					<FolderIcon size={14} />
					<span className="truncate">{f.name}</span>
				</button>
				<button className="mr-1 hidden rounded-[3px] p-0.5 text-muted group-hover:block hover:text-ink" title={`New note in ${f.path}`} onClick={() => newNote(ws.slug, f.path)}>
					<Plus size={13} />
				</button>
			</div>
			{!closed && <FolderItems f={f} ws={ws} route={route} depth={depth + 1} />}
		</div>
	);
}

function NoteItem({ n, ws, route, depth, icon }: { n: Hit; ws: Workspace; route: Route; depth: number; icon?: ReactNode }) {
	const active = route.view === "note" && route.path === n.path;
	return (
		<Link
			href={noteUrl(ws.slug, n.path)}
			onMouseEnter={() => prefetch(ws.slug, n.path)}
			className={`flex items-center gap-1.5 rounded-md py-1 pr-2 text-[13.5px] no-underline ${active ? "bg-accent-soft text-ink" : "text-ink/85 hover:bg-accent-soft/60"}`}
			style={{ paddingLeft: depth * 12 + 8 + 13 + 6 }}
			title={n.path}
		>
			<span className="-ml-[19px] w-[13px] shrink-0 text-muted">{icon ?? <FileText size={13} />}</span>
			<span className="truncate">{n.title}</span>
		</Link>
	);
}

function ThemeToggle() {
	const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches));
	return (
		<button
			className="btn-ghost px-1.5"
			title="Toggle dark mode"
			onClick={() => {
				const next = dark ? "light" : "dark";
				document.documentElement.dataset.theme = next;
				try {
					localStorage.setItem("gm-theme", next);
				} catch {}
				setDark(!dark);
			}}
		>
			{dark ? <Sun size={15} /> : <Moon size={15} />}
		</button>
	);
}

function Toasts() {
	const toasts = useStore((s) => s.toasts);
	return (
		<div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
			{toasts.map((t) => (
				<div key={t.id} className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border px-3 py-2 text-[13.5px] shadow-lg ${t.error ? "border-danger/40 bg-surface text-danger" : "border-line bg-surface"}`}>
					<span className="flex-1">{t.text}</span>
					<X size={14} className="mt-0.5 shrink-0 opacity-50" />
				</div>
			))}
		</div>
	);
}

