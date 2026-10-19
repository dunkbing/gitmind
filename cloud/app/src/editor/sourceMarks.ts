// Source mode's highlighting of gitmind's own constructs, which Markdown's
// grammar doesn't know: a fact's "[category]" and inline #tags.

import { Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";

const category = Decoration.mark({ class: "gm-src-category" });
const tag = Decoration.mark({ class: "gm-src-tag" });

const marks = new MatchDecorator({
	regexp: /(^\s*[-*]\s+)(\[[^\][]+\])|(^|[\s(])(#\p{L}[\p{L}\p{N}_/-]*)/gmu,
	decorate: (add, from, _to, m) => {
		if (m[2]) {
			const start = from + m[1].length;
			if (!/^\[[ xX]\]$/.test(m[2])) add(start, start + m[2].length, category); // not a task checkbox
		} else {
			const start = from + m[3].length;
			add(start, start + m[4].length, tag);
		}
	},
});

export const sourceMarks = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = marks.createDeco(view);
		}
		update(u: ViewUpdate) {
			this.decorations = marks.updateDeco(u, this.decorations);
		}
	},
	{ decorations: (v) => v.decorations },
);
