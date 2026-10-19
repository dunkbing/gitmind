// Workspace settings: connecting AI apps, importing, members and invites
// for teams, and the data itself.

import { Copy, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { type Settings, type Workspace, api } from "../api";
import { navigate } from "../router";
import { loadMe, toast, useStore } from "../store";
import { ConnectApps } from "./Connect";
import { ImportNotes } from "./Import";

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

	// Links like settings#connect scroll to their section.
	useEffect(() => {
		if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
	}, []);

	return (
		<div className="mx-auto max-w-[760px] px-5 py-10 md:px-10">
			<h1 className="view-title">{ws.name}</h1>
			<p className="mt-1 text-[14px] text-muted">
				{ws.kind === "team" ? "Team workspace" : "Personal workspace"} · your role: {ws.role}
				{s && ` · ${s.stats.notes} notes`} · agents pass <code className="rounded bg-accent-soft px-1 font-mono text-[12.5px]">{ws.slug}</code> as the workspace
			</p>

			<section id="connect" className="mt-10 scroll-mt-6">
				<h2 className="font-serif text-[19px]">Connect your AI apps</h2>
				<ConnectApps />
			</section>

			<section id="import" className="mt-10 scroll-mt-6">
				<h2 className="font-serif text-[19px]">Import</h2>
				<ImportNotes ws={ws} />
			</section>

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

			<section className="mt-10">
				<h2 className="font-serif text-[19px]">Your data</h2>
				<p className="mt-2 text-[14px]">It's a git repository of Markdown files, and it's yours. The CLI above keeps a synced clone on your computer.</p>
				<a className="btn-outline mt-3" href={`/w/${encodeURIComponent(ws.slug)}/export.zip`}>
					<Download size={14} /> Download all notes (zip)
				</a>
				{s && <p className="mt-3 text-[13px] text-muted">{searchStatus(s.stats)}</p>}
			</section>
		</div>
	);
}

// searchStatus says how far search by meaning has indexed the notes.
function searchStatus(st: Settings["stats"]): string {
	if (!st.model) return "Search: keywords only (no embedding model configured).";
	if (st.embedded >= st.passages) return "Search by meaning is up to date.";
	return `Indexing for search by meaning: ${st.embedded} of ${st.passages} passages; the rest are found by their words meanwhile.`;
}
