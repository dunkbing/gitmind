// The inbox: what AI apps changed in your memory, for review. Changes are
// already in effect (agents need them right away); accepting keeps one,
// rejecting undoes it, and a reason for rejecting teaches agents through a
// pinned "Memory feedback" note. A change whose new facts may conflict with
// facts already in memory lists them, with a way to retire the old one.

import { Check, ExternalLink, FilePlus2, FileMinus2, FilePen, Inbox as InboxIcon, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { parse } from "../../../src/engine/notes";
import { type FactConflict, type InboxItem, type ReviewSettings, type Workspace, api } from "../api";
import { diffLines, hunks } from "../diff";
import { ago } from "../notes";
import { Link, noteUrl, wsUrl } from "../router";
import { forgetNote, loadInboxCount, loadNotes, toast } from "../store";

export function InboxView({ ws }: { ws: Workspace }) {
	const [data, setData] = useState<{ items: InboxItem[]; settings: ReviewSettings; sources: string[] } | null>(null);
	const [error, setError] = useState("");
	const [onlyConflicts, setOnlyConflicts] = useState(false);
	const withConflicts = data?.items.filter((i) => i.conflicts.length > 0).length ?? 0;
	const reload = () =>
		api.inbox(ws.slug).then(
			(d) => {
				setData(d);
				loadInboxCount(ws.slug).catch(() => {});
			},
			(e) => setError(e.message),
		);
	useEffect(() => {
		setData(null);
		reload();
	}, [ws.slug]);

	const done = (id: number) => {
		setData((d) => d && { ...d, items: d.items.filter((i) => i.id !== id) });
		loadInboxCount(ws.slug).catch(() => {});
	};

	const acceptAll = async () => {
		try {
			await api.accept(ws.slug, "all");
			setData((d) => d && { ...d, items: [] });
			loadInboxCount(ws.slug).catch(() => {});
			toast("Accepted everything");
		} catch (e) {
			toast((e as Error).message, true);
		}
	};

	return (
		<div className="mx-auto max-w-[860px] px-5 py-10 md:px-10">
			<div className="flex items-end justify-between gap-4">
				<div>
					<h1 className="view-title">Inbox</h1>
					<p className="mt-1 text-[14px] text-muted">What AI apps saved to your memory. It's already in use: accept what's right, reject what isn't.</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{withConflicts > 0 && (
						<button
							className={onlyConflicts ? "btn" : "btn-outline"}
							aria-pressed={onlyConflicts}
							onClick={() => setOnlyConflicts((v) => !v)}
							title="Changes whose new facts may contradict or repeat facts already in memory"
						>
							<TriangleAlert size={14} /> Possible conflicts ({withConflicts})
						</button>
					)}
					{data && data.items.length > 1 && (
						<button className="btn-outline" onClick={acceptAll}>
							<Check size={14} /> Accept all
						</button>
					)}
				</div>
			</div>
			{error && <p className="mt-6 text-danger">{error}</p>}
			{!data && !error && <p className="mt-8 animate-pulse text-muted">Loading…</p>}
			{data && !data.settings.enabled && (
				<p className="mt-6 rounded-lg border border-line px-3.5 py-2.5 text-[14px]">
					Review is off: AI apps' changes don't come here. Turn it on in <Link href={wsUrl(ws.slug, "settings")}>Settings</Link>.
				</p>
			)}
			{data && data.items.length === 0 && data.settings.enabled && (
				<div className="mt-16 flex flex-col items-center text-center text-muted">
					<InboxIcon size={28} strokeWidth={1.5} />
					<p className="mt-3 text-[15px] text-ink">All caught up</p>
					<p className="mt-1 text-[13.5px]">When Claude, ChatGPT or your coding agents save something, it shows up here.</p>
				</div>
			)}
			<div className="mt-6 flex flex-col gap-4">
				{data?.items
					.filter((item) => !onlyConflicts || item.conflicts.length > 0)
					.map((item) => (
						<Item key={item.id} ws={ws} item={item} onDone={() => done(item.id)} />
					))}
			</div>
		</div>
	);
}

function Item({ ws, item, onDone }: { ws: Workspace; item: InboxItem; onDone: () => void }) {
	const [rejecting, setRejecting] = useState(false);
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const kind = item.before === null ? "new" : item.after === null ? "deleted" : "edited";
	const title = parse(item.path, item.after ?? item.before ?? "").title;
	const lines = useMemo(() => {
		// Compare bodies and the frontmatter that matters, not timestamps.
		const strip = (c: string | null) => (c ?? "").replace(/^created: .*\n/m, "");
		return diffLines(strip(item.before), strip(item.after));
	}, [item]);
	const shown = kind === "edited" ? hunks(lines) : lines.filter((l) => !/^(---|created: .*)$/.test(l.text));

	const act = async (f: () => Promise<unknown>, message: string) => {
		setBusy(true);
		try {
			await f();
			forgetNote(ws.slug, item.path);
			loadNotes(ws.slug, true).catch(() => {});
			toast(message);
			onDone();
		} catch (e) {
			toast((e as Error).message, true);
			setBusy(false);
		}
	};

	const Icon = kind === "new" ? FilePlus2 : kind === "deleted" ? FileMinus2 : FilePen;
	return (
		<article className="card overflow-hidden">
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3">
				<Icon size={16} className="text-muted" />
				<span className="text-[15px] font-medium">{title}</span>
				<span className="text-[12.5px] text-muted">{kind === "new" ? "new note" : kind === "deleted" ? "deleted" : "edited"}</span>
				<span className="ml-auto flex items-center gap-2 text-[12.5px] text-muted">
					<span className="chip">{item.source}</span>
					<span title={new Date(item.updated).toLocaleString()}>{ago(item.updated)}</span>
				</span>
			</header>
			<div className="max-h-[360px] overflow-auto py-2 font-mono text-[12.5px] leading-relaxed">
				{shown.map((l, i) =>
					l === null ? (
						<div key={i} className="px-4 py-0.5 text-muted">
							⋯
						</div>
					) : (
						<div
							key={i}
							className={`flex gap-2 px-4 whitespace-pre-wrap ${l.kind === "add" ? "bg-accent-soft text-ink" : l.kind === "del" ? "bg-danger/10 text-danger line-through decoration-danger/40" : "text-muted"}`}
						>
							<span className="w-3 shrink-0 select-none opacity-60">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
							<span className="min-w-0 break-words">{l.text || " "}</span>
						</div>
					),
				)}
			</div>
			{item.conflicts.length > 0 && <Conflicts ws={ws} conflicts={item.conflicts} />}
			<footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
				{!rejecting ? (
					<>
						<button className="btn" disabled={busy} onClick={() => act(() => api.accept(ws.slug, [item.id]), "Accepted")}>
							<Check size={14} /> Accept
						</button>
						<button className="btn-outline" disabled={busy} onClick={() => setRejecting(true)}>
							<X size={14} /> Reject
						</button>
						{kind !== "deleted" && (
							<Link href={noteUrl(ws.slug, item.path)} className="btn-ghost ml-auto">
								<ExternalLink size={14} /> Open note
							</Link>
						)}
					</>
				) : (
					<form
						className="flex w-full flex-wrap items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							act(() => api.reject(ws.slug, item.id, reason), kind === "new" ? "Rejected: the note is removed" : "Rejected: the note is back to how it was");
						}}
					>
						<input
							className="field min-w-[220px] flex-1"
							autoFocus
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							placeholder="Why? (optional) e.g. one-off debugging steps"
							title="Added to a pinned Memory feedback note, so agents stop saving this kind of thing"
						/>
						<button className="btn-danger" disabled={busy}>
							{kind === "new" ? "Remove note" : kind === "deleted" ? "Restore note" : "Undo change"}
						</button>
						<button type="button" className="btn-ghost" onClick={() => setRejecting(false)}>
							Cancel
						</button>
					</form>
				)}
			</footer>
		</article>
	);
}

// Conflicts lists facts already in memory that a change's new facts may
// replace or repeat. Retiring one moves it to its note's History.
function Conflicts({ ws, conflicts }: { ws: Workspace; conflicts: FactConflict[] }) {
	const [retired, setRetired] = useState<string[]>([]);
	const key = (c: FactConflict) => `${c.with.path}\0${c.with.category}\0${c.with.text}`;
	const open = conflicts.filter((c) => !retired.includes(key(c)));
	if (!open.length) return null;

	const retire = async (c: FactConflict) => {
		try {
			await api.supersede(ws.slug, c.with.path, `[${c.with.category}] ${c.with.text}`);
			forgetNote(ws.slug, c.with.path);
			setRetired((r) => [...r, key(c)]);
			toast(`Moved to History in ${c.with.title}`);
		} catch (e) {
			toast((e as Error).message, true);
		}
	};

	return (
		<section className="border-t border-line px-4 py-3">
			<p className="flex items-center gap-1.5 text-[13px] font-medium">
				<TriangleAlert size={14} className="text-muted" /> May conflict with what's already in memory
			</p>
			<ul className="mt-2 flex flex-col gap-3">
				{open.map((c) => (
					<li key={key(c)} className="text-[13px] leading-snug">
						<div>
							<span className="text-muted">New:</span> [{c.fact.category}] {c.fact.text}
						</div>
						<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
							<span className="min-w-0 flex-1">
								<span className="text-muted">
									In <Link href={noteUrl(ws.slug, c.with.path)}>{c.with.title}</Link>:
								</span>{" "}
								[{c.with.category}] {c.with.text}
								{c.same && <span className="text-muted"> (same wording)</span>}
							</span>
							<button className="btn-ghost" onClick={() => retire(c)} title="The newer fact replaces it; it's kept under the note's History heading">
								Move old to History
							</button>
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
