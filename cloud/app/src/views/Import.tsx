// Import a Claude or ChatGPT export, or a zip of Markdown notes.

import { Upload } from "lucide-react";
import { useState } from "react";
import { type Workspace, api } from "../api";
import { loadNotes, toast } from "../store";

export function ImportView({ ws }: { ws: Workspace }) {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState("");
	const [drag, setDrag] = useState(false);

	const upload = async (file: File | undefined) => {
		if (!file) return;
		setBusy(true);
		setResult("");
		try {
			const r = await api.importFile(ws.slug, file);
			setResult(`Imported ${r.written.length} note(s) from ${r.source}${r.skipped.length ? `; skipped ${r.skipped.length} that already existed` : ""}.`);
			loadNotes(ws.slug, true).catch(() => {});
		} catch (e) {
			toast(`Import failed: ${(e as Error).message}`, true);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="mx-auto max-w-[720px] px-5 py-10 md:px-10">
			<h1 className="view-title">Import</h1>
			<p className="mt-1 text-[14px] text-muted">Bring in what your AI apps already know.</p>
			<label
				className={`card mt-6 flex cursor-pointer flex-col items-center gap-2 border-dashed p-10 text-center transition ${drag ? "border-accent bg-accent-soft" : ""}`}
				onDragOver={(e) => {
					e.preventDefault();
					setDrag(true);
				}}
				onDragLeave={() => setDrag(false)}
				onDrop={(e) => {
					e.preventDefault();
					setDrag(false);
					upload(e.dataTransfer.files[0]);
				}}
			>
				<Upload size={22} className="text-muted" />
				<span className="text-[15px]">{busy ? "Importing…" : "Drop a zip here, or click to choose one"}</span>
				<span className="text-[13px] text-muted">.zip or .json</span>
				<input type="file" accept=".zip,.json" className="hidden" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
			</label>
			{result && <div className="mt-4 rounded-lg border border-line bg-accent-soft px-3.5 py-2.5 text-[14px]">{result}</div>}
			<div className="prose-gm mt-8">
				<h2>What you can import</h2>
				<p>
					<strong>Claude</strong>: claude.ai → Settings → Privacy → <em>Export data</em>, then upload the zip you receive.
				</p>
				<p>
					<strong>ChatGPT</strong>: Settings → Data controls → <em>Export data</em>, then upload the zip.
				</p>
				<p>
					<strong>Markdown notes</strong>: a zip of a folder (Basic Memory, Obsidian, gitmind). Paths are kept.
				</p>
				<p className="text-muted">
					Conversations become searchable notes under <code>imports/claude/</code> or <code>imports/chatgpt/</code>, one per conversation, in a single commit. Existing notes are never overwritten. Ask an agent to read imported conversations and
					save the lasting facts as regular notes.
				</p>
			</div>
		</div>
	);
}
