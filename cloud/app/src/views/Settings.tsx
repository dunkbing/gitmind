// Workspace settings: members and invites for teams, export, and the CLI.

import { Copy, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { type Settings, type Workspace, api } from "../api";
import { navigate } from "../router";
import { loadMe, toast, useStore } from "../store";

export function SettingsView({ ws }: { ws: Workspace }) {
	const me = useStore((s) => s.me)!;
	const [s, setS] = useState<Settings | null>(null);
	const [role, setRole] = useState("member");
	const [invite, setInvite] = useState("");
	const reload = () => api.settings(ws.slug).then(setS, (e) => toast(e.message, true));
	useEffect(() => {
		setS(null);
		setInvite("");
		reload();
	}, [ws.slug]);

	const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast("Copied"));

	return (
		<div className="mx-auto max-w-[760px] px-5 py-10 md:px-10">
			<h1 className="view-title">{ws.name}</h1>
			<p className="mt-1 text-[14px] text-muted">
				{ws.kind === "team" ? "Team workspace" : "Personal workspace"} · your role: {ws.role}
				{s && ` · ${s.stats.notes} notes`} · agents pass <code className="rounded bg-accent-soft px-1 font-mono text-[12.5px]">{ws.slug}</code> as the workspace
			</p>

			{ws.kind === "team" && (
				<section className="mt-10">
					<h2 className="font-serif text-[19px]">Members</h2>
					<div className="card mt-3 divide-y divide-line">
						{s?.members.map((m) => (
							<div key={m.user_id} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
								<span className="flex-1">
									{m.login} {m.name && <span className="text-muted">{m.name}</span>}
								</span>
								<span className="text-[13px] text-muted">{m.role}</span>
								{m.role !== "owner" && (s.canManage || m.user_id === me.user.id) && (
									<button
										className="btn-ghost py-0.5 text-[13px]"
										onClick={async () => {
											try {
												await api.removeMember(ws.slug, m.user_id);
												if (m.user_id === me.user.id) {
													await loadMe();
													navigate("/app");
													location.href = "/app";
												} else reload();
											} catch (e) {
												toast((e as Error).message, true);
											}
										}}
									>
										{m.user_id === me.user.id ? "Leave" : "Remove"}
									</button>
								)}
							</div>
						))}
					</div>
					{s?.canManage && (
						<div className="mt-3 flex flex-wrap items-center gap-2">
							<select className="field w-auto" value={role} onChange={(e) => setRole(e.target.value)}>
								<option value="member">member</option>
								<option value="admin">admin</option>
							</select>
							<button
								className="btn"
								onClick={async () => {
									try {
										setInvite((await api.invite(ws.slug, role)).url);
									} catch (e) {
										toast((e as Error).message, true);
									}
								}}
							>
								Create invite link
							</button>
							<span className="text-[13px] text-muted">Links work once and expire after 7 days.</span>
						</div>
					)}
					{invite && (
						<div className="mt-3 flex items-center gap-2">
							<div className="box flex-1">{invite}</div>
							<button className="btn-outline" onClick={() => copy(invite)}>
								<Copy size={14} />
							</button>
						</div>
					)}
				</section>
			)}

			{s && (
				<section className="mt-10">
					<h2 className="font-serif text-[19px]">Search</h2>
					<p className="mt-2 text-[14px]">
						{!s.stats.model
							? "Keyword search: this server has no embedding model configured."
							: s.stats.passages === 0
								? "Search by meaning is ready; notes are indexed as they're written."
								: s.stats.embedded >= s.stats.passages
									? `Search by meaning covers all ${s.stats.passages} passages of your notes.`
									: `Indexing for search by meaning: ${s.stats.embedded} of ${s.stats.passages} passages so far; notes not indexed yet are found by their words.`}
					</p>
					{s.stats.model && <p className="mt-1 text-[13px] text-muted">Embeddings: {s.stats.model} (Cloudflare Workers AI), kept beside your notes, never in the git repository.</p>}
				</section>
			)}

			<section className="mt-10">
				<h2 className="font-serif text-[19px]">Your data</h2>
				<p className="mt-2 text-[14px]">It's a git repository of Markdown files, and it's yours.</p>
				<a className="btn-outline mt-3" href={`/w/${encodeURIComponent(ws.slug)}/export.zip`}>
					<Download size={14} /> Download all notes (zip)
				</a>
				{s && (
					<>
						<p className="mt-5 text-[14px]">Keep a synced clone on your computer with the CLI:</p>
						<div className="mt-2 flex items-center gap-2">
							<div className="box flex-1">{s.setupCommand}</div>
							<button className="btn-outline" onClick={() => copy(s.setupCommand)}>
								<Copy size={14} />
							</button>
						</div>
					</>
				)}
			</section>
		</div>
	);
}
