// The note editor: CodeMirror with Markdown, live preview, [[link]]
// completion and the usual formatting shortcuts.

import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { frontmatter } from "./frontmatter";
import { foldHistory, historyFolding } from "./historyFold";
import { linkClicks, livePreview } from "./livePreview";
import { searchPanel } from "./searchPanel";
import { sourceMarks } from "./sourceMarks";

// Obsidian's two editing views: live preview (formatted, syntax shown where
// you edit) and source (the raw file, highlighted).
export type Mode = "live" | "source";

export interface EditorProps {
	mode: Mode;
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

// Markdown, plus the code in fenced blocks (```js, ```go…), whose
// languages load when a note first uses them.
const highlight = HighlightStyle.define([
	{ tag: t.heading, fontWeight: "600" },
	{ tag: t.strong, fontWeight: "600" },
	{ tag: t.emphasis, fontStyle: "italic" },
	{ tag: t.strikethrough, textDecoration: "line-through" },
	{ tag: t.quote, color: "var(--ink-muted)", fontStyle: "italic" },
	{ tag: [t.link, t.url], color: "var(--accent)" },
	{ tag: t.monospace, fontFamily: "var(--font-mono)", color: "var(--code)" },
	{ tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--ink-muted)" },
	{ tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--accent)" },
	{ tag: [t.string, t.special(t.string), t.regexp], color: "var(--code)" },
	{ tag: t.comment, color: "var(--ink-muted)", fontStyle: "italic" },
	{ tag: [t.number, t.bool, t.null, t.atom], color: "var(--code-2)" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName), t.typeName, t.className], color: "var(--code-3)" },
	{ tag: [t.tagName, t.attributeName, t.propertyName], color: "var(--code-3)" },
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

const editability = (p: EditorProps) => {
	const locked = !!p.readOnly;
	return [EditorState.readOnly.of(locked), EditorView.editable.of(!locked)];
};

// The editor is built once per mode; the parent keys it by mode.
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
			markdown({ base: markdownLanguage, addKeymap: true, extensions: [frontmatter], codeLanguages: languages }),
			syntaxHighlighting(highlight),
			historyFolding,
			p.mode === "source" ? [EditorView.editorAttributes.of({ class: "gm-source" }), sourceMarks] : livePreview,
			search({ top: true, createPanel: searchPanel }),
			highlightSelectionMatches({ minSelectionLength: 3 }),
			autocompletion({ override: [wikiCompletion(() => props.current.titles())], icons: false }),
			placeholder("Start writing… Use [[ to link a note, - [decision] for a fact, #tag to tag it."),
			keymap.of([
				{ key: "Mod-b", run: wrap("**") },
				{ key: "Mod-i", run: wrap("*") },
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
			p.mode === "source" ? [] : linkClicks({ wiki: (target) => props.current.onWikiLink(target), tag: (tag) => props.current.onTag(tag) }),
			editable.current.of(editability(p)),
			EditorView.updateListener.of((u) => {
				if (u.docChanged) props.current.onChange(u.state.doc.toString());
			}),
		];
		const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: p.value, extensions }) });
		view.current = v;
		if (p.viewRef) p.viewRef.current = v;
		if (p.mode !== "source") foldHistory(v);
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
		view.current?.dispatch({ effects: editable.current.reconfigure(editability(p)) });
	}, [p.readOnly, p.mode]);

	return <div ref={host} className="gm-editor" />;
}
