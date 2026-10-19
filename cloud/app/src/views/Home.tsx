// A workspace's home: pinned notes, recently edited notes, and a start
// guide while it's empty.

import { FileText, Pin, Plus, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { type Hit, type ProfileFact, type Workspace, api } from "../api";
import { newNote } from "../App";
import { ago, dirOf } from "../notes";
import { Link, noteUrl, wsUrl } from "../router";
import { prefetch, useStore } from "../store";

export function HomeView({ ws }: { ws: Workspace }) {
	const notes = useStore((s) => s.notes[ws.slug]);
	const recent = useMemo(() => [...(notes ?? [])].sort((a, b) => b.updated - a.updated).slice(0, 24), [notes]);
	const pinned = useMemo(() => (notes ?? []).filter((n) => n.pinned), [notes]);
	// The profile agents get at the start of every session.
	const [profile, setProfile] = useState<ProfileFact[] | null>(null);
	useEffect(() => {
		api.profile(ws.slug).then(setProfile, () => setProfile([]));
	}, [ws.slug, notes]);

	return (
		<div className="mx-auto max-w-[920px] px-5 py-10 md:px-10">
			<div className="flex items-end justify-between gap-4">
				<div>
					<h1 className="view-title">{ws.name}</h1>
					<p className="mt-1 text-[14px] text-muted">
						{notes ? `${notes.length} notes` : "Loading…"} · {ws.kind === "team" ? "team workspace" : "personal workspace"}
					</p>
				</div>
				<button className="btn" onClick={() => newNote(ws.slug, "")}>
					<Plus size={15} /> New note
				</button>
			</div>

			{notes && notes.length === 0 && (
				<div className="card mt-8 p-6">
					<h2 className="font-serif text-[20px]">Your memory is empty</h2>
					<ul className="mt-3 space-y-2 text-[14.5px]">
						<li>
							<Link href={wsUrl(ws.slug, "settings") + "#connect"}>Connect an AI app</Link>: Claude, ChatGPT, Claude Code or Codex will save what they learn here.
						</li>
						<li>
							<Link href={wsUrl(ws.slug, "settings") + "#import"}>Import your Claude or ChatGPT history</Link>, or a folder of Markdown notes.
						</li>
						<li>
							<button className="text-accent underline-offset-2 hover:underline" onClick={() => newNote(ws.slug, "")}>
								Write a note
							</button>{" "}
							yourself.
						</li>
					</ul>
				</div>
			)}

			{profile && profile.length > 0 && (
				<section className="mt-10">
					<h2 className="label mb-3 flex items-center gap-1.5">
						<UserRound size={12} /> Profile · what agents are told at the start of every session
					</h2>
					<div className="card divide-y divide-line">
						{(["instruction", "preference"] as const).map((cat) => {
							const facts = profile.filter((f) => f.category === cat);
							if (!facts.length) return null;
							return (
								<div key={cat} className="px-4 py-3">
									<div className="mb-1.5 text-[12.5px] text-muted">{cat === "instruction" ? "Instructions" : "Preferences"}</div>
									<ul className="space-y-1 text-[14px]">
										{facts.slice(0, 40).map((f, i) => (
											<li key={i} className="flex gap-2">
												<span className="min-w-0 flex-1">{f.text}</span>
												<Link href={noteUrl(ws.slug, f.path)} className="shrink-0 text-[12.5px] text-muted no-underline hover:text-accent">
													{f.title}
												</Link>
											</li>
										))}
									</ul>
								</div>
							);
						})}
					</div>
					<p className="mt-2 text-[12.5px] text-muted">
						Gathered from <code>[instruction]</code> and <code>[preference]</code> lines in your general notes (and each project's own, in that project). Edit a note to change them.
					</p>
				</section>
			)}

			{pinned.length > 0 && (
				<section className="mt-10">
					<h2 className="label mb-3 flex items-center gap-1.5">
						<Pin size={12} /> Pinned · shown to agents at the start of every session
					</h2>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{pinned.map((n) => (
							<Card key={n.path} n={n} ws={ws} />
						))}
					</div>
				</section>
			)}

			{recent.length > 0 && (
				<section className="mt-10">
					<h2 className="label mb-3">Recently edited</h2>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{recent.map((n) => (
							<Card key={n.path} n={n} ws={ws} />
						))}
					</div>
				</section>
			)}

		</div>
	);
}

function Card({ n, ws }: { n: Hit; ws: Workspace }) {
	const line = n.summary.replace(/^\s*[-*]\s+/, "");
	const cat = /^\[([^\][]+)\]\s+(.*)$/.exec(line);
	return (
		<Link
			href={noteUrl(ws.slug, n.path)}
			onMouseEnter={() => prefetch(ws.slug, n.path)}
			className="card group flex min-h-[112px] flex-col p-4 text-ink no-underline transition hover:border-accent/50 hover:shadow-sm"
		>
			<div className="flex items-center gap-1.5 text-[14.5px] font-medium">
				<FileText size={14} className="shrink-0 text-muted" />
				<span className="truncate">{n.title}</span>
			</div>
			<p className="mt-1.5 line-clamp-2 flex-1 text-[13px] text-muted">
				{cat ? (
					<>
						<span className="mr-1 rounded bg-accent-soft px-1 font-mono text-[11px] text-accent">{cat[1]}</span>
						{cat[2]}
					</>
				) : (
					line
				)}
			</p>
			<div className="mt-2 flex items-center justify-between text-[12px] text-muted">
				<span className="truncate">{dirOf(n.path)}</span>
				<span className="shrink-0">{ago(n.updated)}</span>
			</div>
		</Link>
	);
}
