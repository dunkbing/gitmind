// Full-text search with tag, category and date filters, as agents search.

import { Search as SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { type Hit, type Workspace, api } from "../api";
import { ago, dirOf } from "../notes";
import { Link, navigate, noteUrl, useLocation, wsUrl } from "../router";
import { prefetch } from "../store";

export function SearchView({ ws }: { ws: Workspace }) {
	const url = useLocation();
	const params = url.searchParams;
	const [form, setForm] = useState({ q: params.get("q") ?? "", tag: params.get("tag") ?? "", category: params.get("category") ?? "", since: params.get("since") ?? "", mode: params.get("mode") ?? "" });
	const [hits, setHits] = useState<Hit[] | null>(null);
	const [error, setError] = useState("");
	const query = { q: params.get("q") ?? "", tag: params.get("tag") ?? "", category: params.get("category") ?? "", since: params.get("since") ?? "", mode: params.get("mode") ?? "" };
	const active = Boolean(query.q || query.tag || query.category || query.since);

	useEffect(() => setForm(query), [url.search]);

	useEffect(() => {
		if (!active) return setHits(null);
		setError("");
		const mode = query.mode === "keyword" ? "keyword" : "hybrid";
		const t = setTimeout(() => api.search(ws.slug, { ...query, mode, limit: 50 }).then(setHits, (e) => setError(e.message)), 120);
		return () => clearTimeout(t);
	}, [ws.slug, url.search]);

	// Typing searches as you go; the URL keeps the query, so back/forward work.
	const update = (patch: Partial<typeof form>) => {
		const next = { ...form, ...patch };
		setForm(next);
		const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v)).toString();
		navigate(wsUrl(ws.slug, "search") + (qs ? `?${qs}` : ""), { replace: true });
	};

	return (
		<div className="mx-auto max-w-[820px] px-5 py-10 md:px-10">
			<h1 className="view-title">Search</h1>
			<div className="mt-5 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 focus-within:border-accent">
				<SearchIcon size={16} className="text-muted" />
				<input autoFocus className="w-full bg-transparent py-2.5 text-[15px] outline-none" placeholder="Search notes" value={form.q} onChange={(e) => update({ q: e.target.value })} />
			</div>
			<div className="mt-2 flex items-center gap-1 text-[13px]" role="radiogroup" aria-label="Match">
				{[
					["", "By meaning and words", "Finds notes that say the same thing in other words, or another language"],
					["keyword", "Exact words", "Only notes containing the words you typed"],
				].map(([m, label, title]) => (
					<button
						key={m}
						role="radio"
						aria-checked={form.mode === m}
						title={title}
						onClick={() => update({ mode: m })}
						className={`rounded-md px-2 py-1 ${form.mode === m ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`}
					>
						{label}
					</button>
				))}
			</div>
			<div className="mt-2 grid grid-cols-3 gap-2">
				<input className="field text-[13px]" placeholder="#tag" value={form.tag} onChange={(e) => update({ tag: e.target.value.replace(/^#/, "") })} />
				<input className="field text-[13px]" placeholder="category, e.g. decision" value={form.category} onChange={(e) => update({ category: e.target.value })} />
				<input className="field text-[13px]" placeholder="since: 30d, 2026-01-01" value={form.since} onChange={(e) => update({ since: e.target.value })} />
			</div>

			{error && <p className="mt-6 text-danger">{error}</p>}
			{!active && (
				<p className="mt-8 text-[14px] text-muted">
					Search finds notes by meaning as well as by their words, so "how do we ship" finds a note about the deploy script. Filter by tag, by observation category (decision, preference, gotcha…) or by date.
				</p>
			)}
			{hits && hits.length === 0 && <p className="mt-8 text-muted">No notes match.</p>}
			<ul className="mt-6 divide-y divide-line">
				{hits?.map((h) => (
					<li key={h.path} className="py-3.5">
						<Link href={noteUrl(ws.slug, h.path)} onMouseEnter={() => prefetch(ws.slug, h.path)} className="text-[15px] font-medium text-ink no-underline hover:text-accent">
							{h.title}
						</Link>
						<div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
							<span>{dirOf(h.path) || "top level"}</span>·<span>{ago(h.updated)}</span>
							{h.tags.map((t) => (
								<button key={t} className="text-accent" onClick={() => update({ tag: t })}>
									#{t}
								</button>
							))}
						</div>
						{h.observations?.length ? (
							<ul className="mt-1.5 list-disc pl-5 text-[13.5px]">
								{h.observations.map((o, i) => (
									<li key={i}>{o}</li>
								))}
							</ul>
						) : (
							<p className="mt-1 text-[13.5px] text-ink/80">
								<Snippet text={h.snippet || h.summary} />
							</p>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}

// The server marks matches as **word**; show them highlighted.
function Snippet({ text }: { text: string }) {
	return (
		<>
			{text.split(/\*\*([^*]+)\*\*/g).map((part, i) =>
				i % 2 ? (
					<mark key={i} className="rounded bg-accent-soft px-0.5 text-ink">
						{part}
					</mark>
				) : (
					part
				),
			)}
		</>
	);
}
