// Obsidian-style live preview for CodeMirror: Markdown is shown formatted
// (headings sized, emphasis applied, syntax marks hidden), and the raw
// syntax comes back on whichever line or span the cursor is in.
// gitmind's own constructs get the same treatment: [[wiki links]] are
// clickable, "- [decision] ..." categories become chips, #tags are tinted.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, RangeSet } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

// Lines the selection touches show their raw Markdown (none while the
// editor isn't focused, so a note opens fully formatted).
function activeLines(state: EditorState, focused: boolean): Set<number> {
	const lines = new Set<number>();
	if (!focused) return lines;
	for (const r of state.selection.ranges) {
		const from = state.doc.lineAt(r.from).number;
		const to = state.doc.lineAt(r.to).number;
		for (let n = from; n <= to; n++) lines.add(n);
	}
	return lines;
}

const hide = Decoration.replace({});

class BulletWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const s = document.createElement("span");
		s.className = "cm-bullet";
		s.textContent = "•";
		return s;
	}
}

class CheckboxWidget extends WidgetType {
	constructor(
		readonly checked: boolean,
		readonly pos: number,
	) {
		super();
	}
	eq(o: CheckboxWidget) {
		return o.checked === this.checked && o.pos === this.pos;
	}
	toDOM(view: EditorView) {
		const box = document.createElement("input");
		box.type = "checkbox";
		box.className = "cm-task";
		box.checked = this.checked;
		box.addEventListener("mousedown", (e) => {
			e.preventDefault();
			if (view.state.readOnly) return;
			view.dispatch({ changes: { from: this.pos, to: this.pos + 3, insert: this.checked ? "[ ]" : "[x]" } });
		});
		return box;
	}
	ignoreEvent() {
		return false;
	}
}

class RuleWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const hr = document.createElement("span");
		hr.className = "cm-hr";
		return hr;
	}
}

const WIKI = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;
const TAG = /(^|[\s(])#([\p{L}\p{N}_/-]+)/gu;
const CATEGORY = /^(\s*[-*+]\s+)\[([^\]\sx][^\]]*|x[^\]]+)\]\s/;

function build(view: EditorView): DecorationSet {
	const { state } = view;
	const focused = view.hasFocus;
	const active = activeLines(state, focused);
	const lineOf = (pos: number) => state.doc.lineAt(pos).number;
	const decos: Range<Decoration>[] = [];
	const selected = (from: number, to: number) => focused && state.selection.ranges.some((r) => r.from <= to && r.to >= from);

	for (const { from, to } of view.visibleRanges) {
		syntaxTree(state).iterate({
			from,
			to,
			enter: (node) => {
				const name = node.name;
				const heading = /^ATXHeading(\d)$/.exec(name);
				if (heading) {
					decos.push(Decoration.line({ class: `cm-h cm-h${heading[1]}` }).range(state.doc.lineAt(node.from).from));
					return;
				}
				if (name === "HeaderMark") {
					if (!active.has(lineOf(node.from))) {
						const after = state.doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
						decos.push(hide.range(node.from, after));
					}
					return;
				}
				if (name === "Emphasis" || name === "StrongEmphasis" || name === "Strikethrough" || name === "InlineCode") {
					const cls = { Emphasis: "cm-em", StrongEmphasis: "cm-strong", Strikethrough: "cm-strike", InlineCode: "cm-code" }[name];
					decos.push(Decoration.mark({ class: cls }).range(node.from, node.to));
					if (!selected(node.from, node.to)) {
						const cursor = node.node.cursor();
						if (cursor.firstChild())
							do {
								if (/Mark$/.test(cursor.name)) decos.push(hide.range(cursor.from, cursor.to));
							} while (cursor.nextSibling());
					}
					return false;
				}
				if (name === "Link") {
					const text = node.node.getChild("LinkMark");
					const marks = node.node.getChildren("LinkMark");
					const url = node.node.getChild("URL");
					if (text && marks.length >= 2) {
						decos.push(Decoration.mark({ class: "cm-link", attributes: url ? { "data-url": state.doc.sliceString(url.from, url.to) } : {} }).range(marks[0].to, marks[1].from));
						if (!selected(node.from, node.to)) {
							decos.push(hide.range(node.from, marks[0].to));
							decos.push(hide.range(marks[1].from, node.to));
						}
					}
					return false;
				}
				if (name === "URL" && node.node.parent?.name !== "Link") {
					decos.push(Decoration.mark({ class: "cm-link", attributes: { "data-url": state.doc.sliceString(node.from, node.to) } }).range(node.from, node.to));
					return;
				}
				if (name === "Blockquote") {
					for (let pos = node.from; pos <= node.to; ) {
						const line = state.doc.lineAt(pos);
						decos.push(Decoration.line({ class: "cm-quote" }).range(line.from));
						pos = line.to + 1;
					}
					return;
				}
				if (name === "QuoteMark" && !active.has(lineOf(node.from))) {
					const after = state.doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
					decos.push(hide.range(node.from, after));
					return;
				}
				if (name === "FencedCode") {
					const first = lineOf(node.from);
					const last = lineOf(node.to);
					for (let n = first; n <= last; n++) {
						const cls = n === first ? "cm-codeblock cm-codeblock-first" : n === last ? "cm-codeblock cm-codeblock-last" : "cm-codeblock";
						decos.push(Decoration.line({ class: cls }).range(state.doc.line(n).from));
					}
					const cursor = node.node.cursor();
					if (cursor.firstChild())
						do {
							if (cursor.name === "CodeMark" || cursor.name === "CodeInfo") decos.push(Decoration.mark({ class: "cm-fence" }).range(cursor.from, cursor.to));
						} while (cursor.nextSibling());
					return false;
				}
				if (name === "HorizontalRule" && !active.has(lineOf(node.from))) {
					decos.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
					return;
				}
				if (name === "TaskMarker") {
					const checked = state.doc.sliceString(node.from, node.to).toLowerCase() === "[x]";
					if (!active.has(lineOf(node.from))) decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, node.from) }).range(node.from, node.to));
					if (checked) {
						const line = state.doc.lineAt(node.from);
						decos.push(Decoration.mark({ class: "cm-done" }).range(node.to, line.to));
					}
					return;
				}
				if (name === "ListMark") {
					const mark = state.doc.sliceString(node.from, node.to);
					const line = state.doc.lineAt(node.from);
					const isTask = /^\s*[-*+]\s+\[[ xX]\]/.test(line.text);
					if (/^[-*+]$/.test(mark) && !active.has(line.number)) {
						// A task's checkbox stands in for its bullet.
						if (isTask) decos.push(hide.range(node.from, Math.min(line.to, node.to + 1)));
						else decos.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
					}
					return;
				}
			},
		});

		// gitmind's constructs, which the Markdown grammar doesn't know.
		for (let pos = from; pos <= to; ) {
			const line = state.doc.lineAt(pos);
			const text = line.text;
			const cat = CATEGORY.exec(text);
			if (cat) {
				const start = line.from + cat[1].length;
				decos.push(Decoration.mark({ class: "cm-category" }).range(start, start + cat[2].length + 2));
			}
			for (const m of text.matchAll(WIKI)) {
				const s = line.from + m.index!;
				const e = s + m[0].length;
				const target = m[1].trim();
				if (selected(s, e)) {
					decos.push(Decoration.mark({ class: "cm-wikilink cm-wikilink-raw", attributes: { "data-target": target } }).range(s, e));
				} else {
					const shown = m[2] ? s + 2 + m[1].length + 1 : s + 2;
					const shownEnd = e - 2;
					decos.push(hide.range(s, shown));
					decos.push(Decoration.mark({ class: "cm-wikilink", attributes: { "data-target": target } }).range(shown, shownEnd));
					decos.push(hide.range(shownEnd, e));
				}
			}
			for (const m of text.matchAll(TAG)) {
				const s = line.from + m.index! + m[1].length;
				decos.push(Decoration.mark({ class: "cm-hashtag", attributes: { "data-tag": m[2] } }).range(s, s + 1 + m[2].length));
			}
			pos = line.to + 1;
		}
	}
	return RangeSet.of(decos, true);
}

export const livePreview = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = build(view);
		}
		update(u: ViewUpdate) {
			if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
		}
	},
	{ decorations: (v) => v.decorations },
);

// Clicking a wiki link, a URL or a #tag follows it.
export function linkClicks(handlers: { wiki: (target: string) => void; tag: (tag: string) => void }) {
	return EditorView.domEventHandlers({
		mousedown(e) {
			const el = (e.target as HTMLElement).closest<HTMLElement>("[data-target],[data-url],[data-tag]");
			if (!el || e.button !== 0) return false;
			// Plain clicks on the raw text (while editing it) just place the cursor.
			if (el.classList.contains("cm-wikilink-raw") && !(e.metaKey || e.ctrlKey)) return false;
			if (el.dataset.target) handlers.wiki(el.dataset.target);
			else if (el.dataset.tag) {
				if (!(e.metaKey || e.ctrlKey)) return false;
				handlers.tag(el.dataset.tag);
			} else if (el.dataset.url) {
				if (!(e.metaKey || e.ctrlKey) && !/^https?:/.test(el.dataset.url)) return false;
				window.open(el.dataset.url, "_blank", "noopener");
			}
			e.preventDefault();
			return true;
		},
	});
}
