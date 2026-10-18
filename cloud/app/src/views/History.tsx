// Every change, from any app or machine, is a git commit; this lists them.

import { GitCommit } from "lucide-react";
import { useEffect, useState } from "react";
import { type Commit, type Workspace, api } from "../api";
import { ago } from "../notes";
import { Link, noteUrl } from "../router";
import { useStore } from "../store";

export function HistoryView({ ws }: { ws: Workspace }) {
	const [log, setLog] = useState<Commit[] | null>(null);
	const [error, setError] = useState("");
	const notes = useStore((s) => s.notes[ws.slug]) ?? [];
	const exists = new Set(notes.map((n) => n.path));
	useEffect(() => {
		api.history(ws.slug).then(setLog, (e) => setError(e.message));
	}, [ws.slug]);
	return (
		<div className="mx-auto max-w-[820px] px-5 py-10 md:px-10">
			<h1 className="view-title">History</h1>
			<p className="mt-1 text-[14px] text-muted">The last 50 changes, from every app and machine. Each one is a git commit.</p>
			{error && <p className="mt-6 text-danger">{error}</p>}
			{!log && !error && <p className="mt-6 animate-pulse text-muted">Loading…</p>}
			{log?.length === 0 && <p className="mt-6 text-muted">No changes yet.</p>}
			<ol className="relative mt-6 border-l border-line pl-5">
				{log?.map((c) => (
					<li key={c.oid} className="mb-5">
						<GitCommit size={14} className="absolute -left-[7.5px] mt-1 bg-paper text-muted" />
						<div className="text-[14px]">{c.message}</div>
						<div className="text-[12.5px] text-muted" title={new Date(c.time).toLocaleString()}>
							{c.author} · {ago(c.time)} · <span className="font-mono">{c.oid.slice(0, 7)}</span>
						</div>
						<div className="mt-1 flex flex-wrap gap-x-3 text-[13px]">
							{c.files
								.filter((f) => f.endsWith(".md"))
								.map((f) =>
									exists.has(f) ? (
										<Link key={f} href={noteUrl(ws.slug, f)}>
											{f.replace(/\.md$/, "")}
										</Link>
									) : (
										<span key={f} className="text-muted line-through" title="Since deleted or moved">
											{f.replace(/\.md$/, "")}
										</span>
									),
								)}
						</div>
					</li>
				))}
			</ol>
		</div>
	);
}
