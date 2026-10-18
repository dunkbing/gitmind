// A note, edited in place: title, tags, then the body in the live-preview
// editor. Changes save on their own a moment after typing stops; renaming
// the title moves the note (and updates links to it).

import { ArrowUpRight, Check, Copy, FolderInput, Link2, Lock, MoreHorizontal, PanelRight, Pin, PinOff, Trash2, X } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { format, links, normalizeTags, parse, type Note } from "../../../src/engine/notes";
import { ApiError, type NoteData, type Workspace, api } from "../api";
import { Editor } from "../editor/Editor";
import { ago, dirOf, resolver } from "../notes";
import { Link, navigate, noteUrl, useLocation, wsUrl } from "../router";
import { cachedNote, forgetNote, loadNote, loadNotes, patchNotes, storeNote, toast, useStore } from "../store";

type Status = "saved" | "dirty" | "saving" | "error";

export function NoteView({ ws, path }: { ws: Workspace; path: string }) {
	const [data, setData] = useState<NoteData | undefined>(() => cachedNote(ws.slug, path));
	const [missing, setMissing] = useState("");
	// Bumped for each note opened, so the editor starts fresh for it, but
	// not for a rename of the open note.
	const [instance, setInstance] = useState(0);
	// The path the open editor is showing. A rename or move changes the URL
	// but keeps the same editor (and whatever was typed meanwhile).
	const showing = useRef(path);
	useEffect(() => {
		if (renamed.current && showing.current === path) {
			renamed.current = false;
			return;
		}
		showing.current = path;
		setMissing("");
		setInstance((i) => i + 1);
		setData(cachedNote(ws.slug, path));
		// Show the cached copy at once, then refresh it in the background.
		forgetNote(ws.slug, path);
		loadNote(ws.slug, path).then(
			(n) => setData((d) => (d && d.path === n.path && d.hash === n.hash ? d : n)),
			(e) => setMissing((e as Error).message),
		);
	}, [ws.slug, path]);
	const renamed = useRef(false);
	const onMoved = (to: string) => {
		renamed.current = true;
		showing.current = to;
		setData((d) => d && { ...d, path: to });
		navigate(noteUrl(ws.slug, to), { replace: true });
	};
	if (missing && !data)
		return (
			<div className="mx-auto max-w-[720px] px-6 py-16">
				<h1 className="view-title">Not found</h1>
				<p className="mt-2 text-muted">{missing}</p>
				<Link className="btn-outline mt-6" href={wsUrl(ws.slug)}>
					Back to Home
				</Link>
			</div>
		);
	if (!data) return <div className="mx-auto max-w-[720px] animate-pulse px-6 py-16 text-muted">Loading…</div>;
	return <NoteEditor key={`${instance}:${data.hash}`} ws={ws} initial={data} onMoved={onMoved} />;
}

function NoteEditor({ ws, initial, onMoved }: { ws: Workspace; initial: NoteData; onMoved: (to: string) => void }) {
	const notes = useStore((s) => s.notes[ws.slug]) ?? [];
	const url = useLocation();
	const [note, setNote] = useState<Note>(() => parse(initial.path, initial.content));
	const [body, setBody] = useState(note.body);
	const [title, setTitle] = useState(note.title);
	const [status, setStatus] = useState<Status>("saved");
	const [conflict, setConflict] = useState<NoteData | null>(null);
	const [panel, setPanel] = useState(() => localStorage.getItem("gm-panel") !== "0");
	const [menu, setMenu] = useState(false);
	const [moving, setMoving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const base = useRef(initial.hash);
	const latest = useRef({ note, body });
	latest.current = { note, body };
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const saving = useRef<Promise<void> | null>(null);
	const titleRef = useRef<HTMLTextAreaElement>(null);
	const editorView = useRef<EditorView | null>(null);
	const [path, setPath] = useState(initial.path);
	const pathRef = useRef(path);
	const movingRef = useRef(false);
	const resolve = useMemo(() => resolver(notes), [notes]);
	const readOnly = note.locked;

	// A note just created from "New note" opens with its title selected.
	useEffect(() => {
		if (url.searchParams.get("new")) {
			titleRef.current?.focus();
			titleRef.current?.select();
			history.replaceState(null, "", noteUrl(ws.slug, path));
		}
	}, []);

	const save = useCallback(async (force = false): Promise<void> => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		// Hold saves while the note is being renamed; moved() saves after.
		if (movingRef.current) {
			timer.current = setTimeout(() => save(), 300);
			return;
		}
		if (saving.current) await saving.current;
		const { note: n, body: b } = latest.current;
		const content = format({ ...n, body: b });
		const path = pathRef.current;
		setStatus("saving");
		const run = (async () => {
			try {
				const saved = await api.save(ws.slug, path, content, force ? "" : base.current);
				base.current = saved.hash;
				storeNote(ws.slug, saved);
				setStatus((s) => (s === "saving" ? "saved" : s));
				const p = parse(path, saved.content);
				patchNotes(ws.slug, (ns) => ns.map((x) => (x.path === path ? { ...x, title: p.title, tags: p.tags, pinned: p.pinned, updated: saved.updated } : x)));
			} catch (e) {
				if (e instanceof ApiError && e.status === 409) {
					setConflict(e.body.current as NoteData);
					setStatus("error");
				} else {
					setStatus("error");
					toast(`Couldn't save: ${(e as Error).message}`, true);
				}
			}
		})();
		saving.current = run;
		await run;
		saving.current = null;
	}, [ws.slug]);

	// After a rename or move: carry on editing the note at its new path.
	const moved = async (to: string, title: string) => {
		const fresh = await api.note(ws.slug, to);
		pathRef.current = to;
		base.current = fresh.hash;
		const n = { ...latest.current.note, title, path: to };
		latest.current.note = n;
		setNote(n);
		setPath(to);
		await loadNotes(ws.slug, true);
		onMoved(to);
		// Anything typed meanwhile was held back by movingRef and saves to
		// the new path once the move is done.
	};

	const schedule = () => {
		setStatus("dirty");
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => save(), 700);
	};

	// Save what's pending when leaving the note or the page.
	useEffect(() => {
		const flush = (e: BeforeUnloadEvent) => {
			if (timer.current) {
				save();
				e.preventDefault();
			}
		};
		addEventListener("beforeunload", flush);
		return () => {
			removeEventListener("beforeunload", flush);
			if (timer.current) save();
		};
	}, [save]);

	const onBody = (b: string) => {
		setBody(b);
		latest.current.body = b;
		schedule();
	};

	const setTags = (tags: string[]) => {
		const n = { ...note, tags: normalizeTags(tags) };
		setNote(n);
		latest.current.note = n;
		schedule();
	};

	const rename = async () => {
		const t = title.trim();
		if (!t || t === note.title) return setTitle(note.title);
		if (timer.current || saving.current) await save();
		try {
			movingRef.current = true;
			const r = await api.move(ws.slug, path, undefined, t);
			await moved(r.path, t);
			toast(r.updated.length ? `Renamed; updated links in ${r.updated.length} note(s)` : "Renamed");
		} catch (e) {
			toast((e as Error).message, true);
			setTitle(note.title);
		} finally {
			movingRef.current = false;
		}
	};

	const moveTo = async (dir: string) => {
		setMoving(false);
		if (dir === dirOf(path)) return;
		if (timer.current || saving.current) await save();
		try {
			movingRef.current = true;
			const r = await api.move(ws.slug, path, dir, undefined);
			await moved(r.path, note.title);
			toast(`Moved to ${dir || "the top level"}`);
		} catch (e) {
			toast((e as Error).message, true);
		} finally {
			movingRef.current = false;
		}
	};

	const togglePin = async () => {
		if (timer.current || saving.current) await save();
		try {
			await api.pin(ws.slug, path, !note.pinned);
			const fresh = await api.note(ws.slug, path);
			base.current = fresh.hash;
			storeNote(ws.slug, fresh);
			setNote((n) => ({ ...n, pinned: !n.pinned }));
			patchNotes(ws.slug, (ns) => ns.map((x) => (x.path === path ? { ...x, pinned: !note.pinned } : x)));
			toast(note.pinned ? "Unpinned" : "Pinned: agents see it in full at the start of every session");
		} catch (e) {
			toast((e as Error).message, true);
		}
	};

	const remove = async () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		try {
			await api.remove(ws.slug, path);
			forgetNote(ws.slug, path);
			patchNotes(ws.slug, (ns) => ns.filter((x) => x.path !== path));
			navigate(wsUrl(ws.slug), { replace: true });
			toast("Deleted. Git history keeps a copy.");
		} catch (e) {
			toast((e as Error).message, true);
		}
	};

	const openLink = async (target: string) => {
		const clean = target.replace(/#.*$/, "");
		const p = resolve(clean);
		if (p) return navigate(noteUrl(ws.slug, p));
		// Like Obsidian: following a link to a note that doesn't exist creates it.
		try {
			const r = await api.create(ws.slug, clean.slice(clean.lastIndexOf("/") + 1), clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : dirOf(path));
			await loadNotes(ws.slug, true);
			navigate(noteUrl(ws.slug, r.path));
		} catch (e) {
			toast((e as Error).message, true);
		}
	};

	const outgoing = useMemo(() => {
		const out: { target: string; path: string | null }[] = [];
		const seen = new Set<string>();
		for (const l of links(body)) {
			const p = resolve(l.target);
			const k = p ?? l.target;
			if (!seen.has(k)) {
				seen.add(k);
				out.push({ target: l.target, path: p });
			}
		}
		return out;
	}, [body, resolve]);

	const outline = useMemo(() => {
		const out: { level: number; text: string; line: number }[] = [];
		let fenced = false;
		body.split("\n").forEach((l, i) => {
			if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
			const m = !fenced && /^(#{1,6})\s+(.+)$/.exec(l);
			if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, ""), line: i + 1 });
		});
		return out;
	}, [body]);

	const titleOf = (p: string) => notes.find((n) => n.path === p)?.title ?? p;
	const crumbs = dirOf(path).split("/").filter(Boolean);

	return (
		<div className="flex min-h-full">
			<div className="min-w-0 flex-1">
				<div className="sticky top-0 z-10 flex items-center gap-1 bg-paper/85 px-4 py-2 backdrop-blur md:px-6">
					<div className="flex min-w-0 flex-1 items-center gap-1 text-[13px] text-muted">
						{crumbs.map((c, i) => (
							<span key={i} className="flex items-center gap-1">
								<span className="truncate">{c}</span>
								<span className="opacity-50">/</span>
							</span>
						))}
						<span className="truncate text-ink">{note.title}</span>
						{readOnly && (
							<span className="chip ml-2 text-muted" title="Locked notes can only be changed by editing the file in git">
								<Lock size={11} /> locked
							</span>
						)}
					</div>
					<SaveStatus status={status} />
					<button className="btn-ghost px-1.5" title={note.pinned ? "Unpin" : "Pin: show in full at the start of every agent session"} onClick={togglePin}>
						{note.pinned ? <PinOff size={16} /> : <Pin size={16} />}
					</button>
					<button
						className={`btn-ghost hidden px-1.5 lg:inline-flex ${panel ? "text-ink" : ""}`}
						title="Links and outline"
						onClick={() => {
							setPanel(!panel);
							localStorage.setItem("gm-panel", panel ? "0" : "1");
						}}
					>
						<PanelRight size={16} />
					</button>
					<div className="relative">
						<button className="btn-ghost px-1.5" onClick={() => setMenu(!menu)} title="More">
							<MoreHorizontal size={16} />
						</button>
						{menu && (
							<div className="absolute right-0 z-30 mt-1 w-52 rounded-lg border border-line bg-surface p-1 text-[13.5px] shadow-xl" onMouseLeave={() => setMenu(false)}>
								<MenuItem icon={<FolderInput size={14} />} onClick={() => (setMenu(false), setMoving(true))}>
									Move to folder…
								</MenuItem>
								<MenuItem
									icon={<Copy size={14} />}
									onClick={() => {
										setMenu(false);
										navigator.clipboard.writeText(`[[${note.title}]]`).then(() => toast("Copied a [[link]] to this note"));
									}}
								>
									Copy [[link]]
								</MenuItem>
								<MenuItem
									icon={<Link2 size={14} />}
									onClick={() => {
										setMenu(false);
										navigator.clipboard.writeText(location.origin + noteUrl(ws.slug, path)).then(() => toast("Copied the page address"));
									}}
								>
									Copy page address
								</MenuItem>
								<MenuItem icon={<Trash2 size={14} />} danger onClick={() => (setMenu(false), setDeleting(true))}>
									Delete
								</MenuItem>
							</div>
						)}
					</div>
				</div>

				{conflict && (
					<div className="mx-auto mt-2 flex max-w-[760px] flex-wrap items-center gap-2 rounded-lg border border-danger/40 px-3 py-2 text-[13.5px] md:mx-12 lg:mx-auto">
						<span className="flex-1 text-danger">This note was changed elsewhere (by an agent or another device) while you were editing.</span>
						<button
							className="btn-outline py-1"
							onClick={() => {
								const fresh = parse(path, conflict.content);
								base.current = conflict.hash;
								setNote(fresh);
								setBody(fresh.body);
								setTitle(fresh.title);
								setConflict(null);
								setStatus("saved");
							}}
						>
							Load their version
						</button>
						<button className="btn py-1" onClick={() => (setConflict(null), save(true))}>
							Keep mine
						</button>
					</div>
				)}

				<div className="mx-auto max-w-[760px] px-5 pt-6 pb-4 md:px-12">
					<textarea
						ref={titleRef}
						rows={1}
						value={title}
						readOnly={readOnly}
						onChange={(e) => setTitle(e.target.value.replace(/\n/g, ""))}
						onBlur={rename}
						onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
							if (e.key === "Enter" || e.key === "ArrowDown") {
								e.preventDefault();
								editorView.current?.focus();
							}
							if (e.key === "Escape") {
								setTitle(note.title);
								(e.target as HTMLTextAreaElement).blur();
							}
						}}
						className="field-sizing-content w-full resize-none bg-transparent font-serif text-[34px] leading-tight font-medium tracking-tight outline-none placeholder:text-muted/50"
						placeholder="Untitled"
					/>
					<Properties note={note} updated={initial.updated} path={path} readOnly={readOnly} onTags={setTags} ws={ws} />
				</div>

				<div className="mx-auto max-w-[760px] px-5 md:px-12">
					<Editor
						value={body}
						onChange={onBody}
						readOnly={readOnly}
						titles={() => notes.map((n) => n.title)}
						onWikiLink={openLink}
						onTag={(tag) => navigate(wsUrl(ws.slug, "search") + `?tag=${encodeURIComponent(tag)}`)}
						onEscapeUp={() => titleRef.current?.focus()}
						viewRef={editorView}
					/>
				</div>
			</div>

			{panel && (
				<aside className="sticky top-0 hidden h-[calc(100vh)] w-[260px] shrink-0 overflow-y-auto border-l border-line px-4 py-5 lg:block">
					{outline.length > 0 && (
						<section className="mb-6">
							<div className="label mb-2">Outline</div>
							{outline.map((h, i) => (
								<button
									key={i}
									className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[13px] text-muted hover:bg-accent-soft/60 hover:text-ink"
									style={{ paddingLeft: (h.level - 1) * 10 + 6 }}
									onClick={() => {
										const v = editorView.current;
										if (!v) return;
										const pos = v.state.doc.line(h.line).from;
										v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
										v.focus();
									}}
								>
									{h.text}
								</button>
							))}
						</section>
					)}
					<section className="mb-6">
						<div className="label mb-2">Links ({outgoing.length})</div>
						{outgoing.length === 0 && <p className="text-[13px] text-muted">None yet. Type [[ to link a note.</p>}
						{outgoing.map((l) =>
							l.path ? (
								<Link key={l.target} href={noteUrl(ws.slug, l.path)} className="block truncate rounded px-1.5 py-0.5 text-[13px] text-ink no-underline hover:bg-accent-soft/60">
									{titleOf(l.path)}
								</Link>
							) : (
								<button key={l.target} className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[13px] text-danger hover:bg-accent-soft/60" onClick={() => openLink(l.target)} title="No such note yet; click to create it">
									{l.target}
								</button>
							),
						)}
					</section>
					<section>
						<div className="label mb-2">Backlinks ({initial.backlinks.length})</div>
						{initial.backlinks.length === 0 && <p className="text-[13px] text-muted">No notes link here.</p>}
						{initial.backlinks.map((b) => (
							<Link key={b.path} href={noteUrl(ws.slug, b.path)} className="block truncate rounded px-1.5 py-0.5 text-[13px] text-ink no-underline hover:bg-accent-soft/60">
								{b.title}
							</Link>
						))}
					</section>
				</aside>
			)}

			{moving && <MoveDialog notes={notes.map((n) => n.path)} current={dirOf(path)} onMove={moveTo} onClose={() => setMoving(false)} />}
			{deleting && (
				<Dialog onClose={() => setDeleting(false)}>
					<h2 className="font-serif text-[20px]">Delete "{note.title}"?</h2>
					<p className="mt-2 text-[14px] text-muted">Agents won't find it any more. Git history keeps a copy, so it can be restored.</p>
					<div className="mt-5 flex justify-end gap-2">
						<button className="btn-outline" onClick={() => setDeleting(false)}>
							Cancel
						</button>
						<button className="btn-danger" autoFocus onClick={() => (setDeleting(false), remove())}>
							Delete
						</button>
					</div>
				</Dialog>
			)}
		</div>
	);
}

function SaveStatus({ status }: { status: Status }) {
	const text = { saved: "Saved", dirty: "Edited", saving: "Saving…", error: "Not saved" }[status];
	return (
		<span className={`mr-1 flex items-center gap-1 text-[12px] ${status === "error" ? "text-danger" : "text-muted"}`}>
			{status === "saved" && <Check size={12} />}
			{text}
		</span>
	);
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
	return (
		<button className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent-soft ${danger ? "text-danger" : ""}`} onClick={onClick}>
			{icon}
			{children}
		</button>
	);
}

function Properties({ note, updated, path, readOnly, onTags, ws }: { note: Note; updated: number; path: string; readOnly: boolean; onTags: (t: string[]) => void; ws: Workspace }) {
	const [adding, setAdding] = useState("");
	return (
		<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-muted">
			<span title={new Date(updated).toLocaleString()}>Edited {ago(updated)}</span>
			{note.created && <span>Created {new Date(note.created).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>}
			<span className="font-mono text-[12px] opacity-80" title="Path in the git repository">
				{path}
			</span>
			<span className="flex flex-wrap items-center gap-1">
				{note.tags.map((t) => (
					<span key={t} className="chip group">
						<Link href={wsUrl(ws.slug, "search") + `?tag=${encodeURIComponent(t)}`} className="text-accent no-underline">
							#{t}
						</Link>
						{!readOnly && (
							<button className="hidden opacity-60 group-hover:inline hover:opacity-100" onClick={() => onTags(note.tags.filter((x) => x !== t))} title={`Remove #${t}`}>
								<X size={11} />
							</button>
						)}
					</span>
				))}
				{!readOnly && (
					<input
						className="w-24 bg-transparent text-[13px] outline-none placeholder:text-muted/60"
						placeholder="+ add tag"
						value={adding}
						onChange={(e) => setAdding(e.target.value.replace(/[\s,#]/g, ""))}
						onKeyDown={(e) => {
							if ((e.key === "Enter" || e.key === ",") && adding) {
								e.preventDefault();
								onTags([...note.tags, adding]);
								setAdding("");
							}
							if (e.key === "Backspace" && !adding && note.tags.length) onTags(note.tags.slice(0, -1));
						}}
						onBlur={() => {
							if (adding) onTags([...note.tags, adding]);
							setAdding("");
						}}
					/>
				)}
			</span>
		</div>
	);
}

export function Dialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
	useEffect(() => {
		const k = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
		addEventListener("keydown", k);
		return () => removeEventListener("keydown", k);
	}, [onClose]);
	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-4 pt-[18vh]" onMouseDown={onClose}>
			<div className="w-full max-w-[440px] rounded-xl border border-line bg-surface p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
				{children}
			</div>
		</div>
	);
}

function MoveDialog({ notes, current, onMove, onClose }: { notes: string[]; current: string; onMove: (dir: string) => void; onClose: () => void }) {
	const [dir, setDir] = useState(current);
	const folders = useMemo(() => {
		const s = new Set<string>([""]);
		for (const p of notes) {
			const parts = p.split("/").slice(0, -1);
			for (let i = 1; i <= parts.length; i++) s.add(parts.slice(0, i).join("/"));
		}
		return [...s].sort();
	}, [notes]);
	const shown = folders.filter((f) => f.includes(dir.toLowerCase()));
	return (
		<Dialog onClose={onClose}>
			<h2 className="font-serif text-[20px]">Move to folder</h2>
			<form
				className="mt-3"
				onSubmit={(e) => {
					e.preventDefault();
					onMove(dir.trim().replace(/^\/+|\/+$/g, ""));
				}}
			>
				<input className="field" autoFocus value={dir} onChange={(e) => setDir(e.target.value)} placeholder="folder, e.g. projects/gitmind (empty for the top level)" />
				<div className="mt-2 max-h-48 overflow-y-auto">
					{shown.map((f) => (
						<button type="button" key={f} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13.5px] hover:bg-accent-soft" onClick={() => onMove(f)}>
							<ArrowUpRight size={13} className="text-muted" />
							{f || <span className="text-muted">Top level</span>}
						</button>
					))}
				</div>
				<div className="mt-4 flex justify-end gap-2">
					<button type="button" className="btn-outline" onClick={onClose}>
						Cancel
					</button>
					<button className="btn">Move</button>
				</div>
			</form>
		</Dialog>
	);
}
