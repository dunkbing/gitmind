// The note editor: CodeMirror with Markdown, live preview, [[link]]
// completion and the usual formatting shortcuts.

import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { linkClicks, livePreview } from "./livePreview";
import { searchPanel } from "./searchPanel";

export interface EditorProps {
	value: string;
	onChange: (value: string) => void;
	readOnly?: boolean;
	titles: () => string[]; // note titles, for [[ completion
	onWikiLink: (target: string) => void;
	onTag: (tag: string) => void;
	autoFocus?: boolean;
	onEscapeUp?: () => void; // ArrowUp on the first line, e.g. to move to the title
	viewRef?: { current: EditorView | null };
}

const highlight = HighlightStyle.define([
	{ tag: t.heading, fontWeight: "600" },
	{ tag: t.monospace, fontFamily: "var(--font-mono)" },
	{ tag: [t.processingInstruction, t.meta], color: "var(--ink-muted)" },
	{ tag: t.keyword, color: "var(--accent)" },
	{ tag: [t.string, t.special(t.string)], color: "#b5651d" },
	{ tag: t.comment, color: "var(--ink-muted)", fontStyle: "italic" },
	{ tag: t.number, color: "#7a5cc4" },
	{ tag: t.url, color: "var(--accent)" },
]);

// wrap toggles a Markdown mark (e.g. ** for bold) around the selection.
const wrap = (mark: string) => (view: EditorView) => {
	view.dispatch(
		view.state.changeByRange((r) => {
			const text = view.state.sliceDoc(r.from, r.to);
			const before = view.state.sliceDoc(r.from - mark.length, r.from);
			const after = view.state.sliceDoc(r.to, r.to + mark.length);
			if (before === mark && after === mark)
				return { changes: [{ from: r.from - mark.length, to: r.from }, { from: r.to, to: r.to + mark.length }], range: r.extend(r.from - mark.length, r.to - mark.length) };
			return { changes: { from: r.from, to: r.to, insert: mark + text + mark }, range: r.extend(r.from + mark.length, r.to + mark.length) };
		}),
	);
	return true;
};

function wikiCompletion(titles: () => string[]) {
	return (ctx: CompletionContext): CompletionResult | null => {
		const m = ctx.matchBefore(/\[\[[^\]\n]*/);
		if (!m) return null;
		const closed = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === "]]";
		return {
			from: m.from + 2,
			options: titles().map((title) => ({ label: title, type: "text", apply: closed ? title : title + "]]" })),
			validFor: /^[^\]\n]*$/,
		};
	};
}

export function Editor(p: EditorProps) {
	const host = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const props = useRef(p);
	props.current = p;
	const editable = useRef(new Compartment());

	useEffect(() => {
		const extensions: Extension[] = [
			history(),
			drawSelection(),
			EditorView.lineWrapping,
			markdown({ base: markdownLanguage, addKeymap: true }),
			syntaxHighlighting(highlight),
			livePreview,
			search({ top: true, createPanel: searchPanel }),
			highlightSelectionMatches({ minSelectionLength: 3 }),
			autocompletion({ override: [wikiCompletion(() => props.current.titles())], icons: false }),
			placeholder("Start writing… Use [[ to link a note, - [decision] for a fact, #tag to tag it."),
			keymap.of([
				{ key: "Mod-b", run: wrap("**") },
				{ key: "Mod-i", run: wrap("*") },
				{ key: "Mod-e", run: wrap("`") },
				{
					key: "ArrowUp",
					run: (v) => {
						const head = v.state.selection.main.head;
						if (v.state.doc.lineAt(head).number !== 1 || !props.current.onEscapeUp) return false;
						props.current.onEscapeUp();
						return true;
					},
				},
				...searchKeymap,
				...historyKeymap,
				...defaultKeymap,
				indentWithTab,
			]),
			linkClicks({ wiki: (target) => props.current.onWikiLink(target), tag: (tag) => props.current.onTag(tag) }),
			editable.current.of([EditorState.readOnly.of(!!p.readOnly), EditorView.editable.of(!p.readOnly)]),
			EditorView.updateListener.of((u) => {
				if (u.docChanged) props.current.onChange(u.state.doc.toString());
			}),
		];
		const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: p.value, extensions }) });
		view.current = v;
		if (p.viewRef) p.viewRef.current = v;
		if (p.autoFocus) v.focus();
		return () => {
			v.destroy();
			view.current = null;
		};
		// The editor is created once per note; the parent keys it by path.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Outside changes (a conflict resolved, a reload) replace the document
	// without being reported back as edits.
	useEffect(() => {
		const v = view.current;
		if (v && v.state.doc.toString() !== p.value) {
			v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: p.value } });
		}
	}, [p.value]);

	useEffect(() => {
		view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(!!p.readOnly), EditorView.editable.of(!p.readOnly)]) });
	}, [p.readOnly]);

	return <div ref={host} className="gm-editor" />;
}
