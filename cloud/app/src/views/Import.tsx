// Import a Claude or ChatGPT export, or a zip of Markdown notes: a section
// of Settings.

import { Upload } from "lucide-react";
import { useState } from "react";
import { type Workspace, api } from "../api";
import { loadNotes, toast } from "../store";

export function ImportNotes({ ws }: { ws: Workspace }) {
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
		<>
			<p className="mt-2 text-[14px]">
				Bring in what your AI apps already know: a <strong>Claude</strong> export (claude.ai → Settings → Privacy → Export data), a <strong>ChatGPT</strong> export (Settings → Data controls → Export
				data), or a zip of <strong>Markdown notes</strong> (Obsidian, Basic Memory).
			</p>
			<label
				className={`card mt-3 flex cursor-pointer flex-col items-center gap-1.5 border-dashed p-6 text-center transition ${drag ? "border-accent bg-accent-soft" : ""}`}
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
				<Upload size={20} className="text-muted" />
				<span className="text-[15px]">{busy ? "Importing…" : "Drop a zip here, or click to choose one"}</span>
				<span className="text-[13px] text-muted">.zip or .json</span>
				<input type="file" accept=".zip,.json" className="hidden" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
			</label>
			{result && <div className="mt-4 rounded-lg border border-line bg-accent-soft px-3.5 py-2.5 text-[14px]">{result}</div>}
			<p className="mt-2 text-[13px] text-muted">
				Conversations become searchable notes under <code>imports/</code>, one per conversation. Existing notes are never overwritten. Then ask an agent to save the lasting facts from them as regular notes.
			</p>
		</>
	);
}
