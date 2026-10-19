// Collapses a note's History sections, where replaced facts are kept, when
// the note opens: they're there for the record, not for everyday reading.
// The placeholder says how many facts are inside; clicking it unfolds.

import { codeFolding, ensureSyntaxTree, foldable, foldEffect } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const heading = /^#{1,6}\s+history\s*#*\s*$/i;

export const historyFolding = codeFolding({
	preparePlaceholder: (state, range) => {
		let facts = 0;
		for (const line of state.sliceDoc(range.from, range.to).split("\n")) if (/^\s*[-*]\s/.test(line)) facts++;
		return facts;
	},
	placeholderDOM: (_view, onclick, facts: number) => {
		const el = document.createElement("button");
		el.className = "gm-history-fold";
		el.textContent = facts === 1 ? "1 earlier fact · show" : `${facts} earlier facts · show`;
		el.title = "Facts that were replaced or removed, kept for the record";
		el.onclick = onclick;
		return el;
	},
});

// historyRanges finds the foldable History sections, outside code fences.
function historyRanges(state: EditorState): { from: number; to: number }[] {
	const out: { from: number; to: number }[] = [];
	let fenced = false;
	for (let n = 1; n <= state.doc.lines; n++) {
		const line = state.doc.line(n);
		if (/^\s*(```|~~~)/.test(line.text)) fenced = !fenced;
		else if (!fenced && heading.test(line.text)) {
			const r = foldable(state, line.from, line.to);
			if (r) out.push(r);
		}
	}
	return out;
}

export function foldHistory(view: EditorView) {
	ensureSyntaxTree(view.state, view.state.doc.length, 200);
	const ranges = historyRanges(view.state);
	if (ranges.length) view.dispatch({ effects: ranges.map((r) => foldEffect.of(r)) });
}
