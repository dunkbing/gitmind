// The find (and replace) bar for ⌘F: one compact row in the app's style
// with a match count, instead of CodeMirror's default form.

import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, setSearchQuery } from "@codemirror/search";
import type { EditorView, Panel, ViewUpdate } from "@codemirror/view";

const icon = (d: string) =>
	`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
	up: icon('<path d="m18 15-6-6-6 6"/>'),
	down: icon('<path d="m6 9 6 6 6-6"/>'),
	close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
	replace: icon('<path d="M14 4c0-1.1.9-2 2-2"/><path d="M20 2c1.1 0 2 .9 2 2"/><path d="M22 8c0 1.1-.9 2-2 2"/><path d="M16 10c-1.1 0-2-.9-2-2"/><path d="m3 7 3 3 3-3"/><path d="M6 10V5c0-1.7 1.3-3 3-3h1"/><rect x="2" y="14" width="8" height="8" rx="2"/>'),
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string>, html = ""): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
	e.innerHTML = html;
	return e;
}

// countMatches reports how many matches there are (up to a limit) and which
// one the selection is on.
function countMatches(view: EditorView, q: SearchQuery): { total: number; current: number } {
	if (!q.valid || !q.search) return { total: 0, current: 0 };
	const sel = view.state.selection.main;
	const cursor = q.getCursor(view.state);
	let total = 0;
	let current = 0;
	for (let r = cursor.next(); !r.done && total < 1000; r = cursor.next()) {
		total++;
		if (r.value.from === sel.from && r.value.to === sel.to) current = total;
	}
	return { total, current };
}

export function searchPanel(view: EditorView): Panel {
	const dom = el("div", { class: "gm-find" });
	const row = el("div", { class: "gm-find-row" });
	const input = el("input", { class: "gm-find-input", placeholder: "Find in note", "aria-label": "Find", "main-field": "true" });
	const count = el("span", { class: "gm-find-count" });
	const toggle = (label: string, title: string) => el("button", { class: "gm-find-toggle", type: "button", title, "aria-pressed": "false" }, label);
	const caseBtn = toggle("Aa", "Match case");
	const wordBtn = toggle("<u>ab</u>", "Whole word");
	const regexBtn = toggle(".*", "Regular expression");
	const btn = (svg: string, title: string) => el("button", { class: "gm-find-btn", type: "button", title }, svg);
	const prev = btn(ICONS.up, "Previous match (⇧Enter)");
	const next = btn(ICONS.down, "Next match (Enter)");
	const replaceToggle = btn(ICONS.replace, "Replace");
	const close = btn(ICONS.close, "Close (Esc)");
	const inputWrap = el("div", { class: "gm-find-field" });
	inputWrap.append(input, count, caseBtn, wordBtn, regexBtn);
	row.append(inputWrap, prev, next, replaceToggle, close);

	const rrow = el("div", { class: "gm-find-row gm-find-replace", hidden: "" });
	const rinput = el("input", { class: "gm-find-input gm-find-field-solo", placeholder: "Replace with", "aria-label": "Replace" });
	const rone = el("button", { class: "gm-find-text", type: "button" }, "Replace");
	const rall = el("button", { class: "gm-find-text", type: "button" }, "All");
	rrow.append(rinput, rone, rall);
	dom.append(row, rrow);

	const pressed = (b: HTMLElement) => b.getAttribute("aria-pressed") === "true";
	const commit = () => {
		const q = new SearchQuery({
			search: input.value,
			replace: rinput.value,
			caseSensitive: pressed(caseBtn),
			wholeWord: pressed(wordBtn),
			regexp: pressed(regexBtn),
		});
		if (!q.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(q) });
	};
	const refresh = () => {
		const q = getSearchQuery(view.state);
		const { total, current } = countMatches(view, q);
		count.textContent = !q.search ? "" : !q.valid ? "invalid" : total === 0 ? "No results" : `${current || "–"} of ${total >= 1000 ? "999+" : total}`;
		dom.classList.toggle("gm-find-none", !!q.search && total === 0);
	};
	const sync = () => {
		const q = getSearchQuery(view.state);
		if (document.activeElement !== input) input.value = q.search;
		if (document.activeElement !== rinput) rinput.value = q.replace;
		caseBtn.setAttribute("aria-pressed", String(q.caseSensitive));
		wordBtn.setAttribute("aria-pressed", String(q.wholeWord));
		regexBtn.setAttribute("aria-pressed", String(q.regexp));
		refresh();
	};

	// Where the search started: typing shows the first match after it.
	let origin = view.state.selection.main.from;
	input.addEventListener("input", () => {
		commit();
		// Jump to the first match as you type, like a browser's find. (Not
		// with findNext, which selects the text in this box.)
		const q = getSearchQuery(view.state);
		if (q.valid && q.search) {
			let m = q.getCursor(view.state, origin).next();
			if (m.done) m = q.getCursor(view.state).next();
			if (!m.done) view.dispatch({ selection: { anchor: m.value.from, head: m.value.to }, scrollIntoView: true, userEvent: "select.search" });
		}
		refresh();
	});
	rinput.addEventListener("input", commit);
	for (const b of [caseBtn, wordBtn, regexBtn])
		b.addEventListener("click", () => {
			b.setAttribute("aria-pressed", String(!pressed(b)));
			commit();
			refresh();
		});
	const go = (f: (v: EditorView) => boolean) => () => {
		const field = document.activeElement === rinput ? rinput : input;
		commit();
		f(view);
		origin = view.state.selection.main.from;
		// The commands select the search text; keep the cursor where it was.
		field.focus();
		field.setSelectionRange(field.value.length, field.value.length);
		refresh();
	};
	prev.addEventListener("click", go(findPrevious));
	next.addEventListener("click", go(findNext));
	rone.addEventListener("click", go(replaceNext));
	rall.addEventListener("click", go(replaceAll));
	close.addEventListener("click", () => closeSearchPanel(view));
	replaceToggle.addEventListener("click", () => {
		const show = rrow.hasAttribute("hidden");
		rrow.toggleAttribute("hidden", !show);
		replaceToggle.classList.toggle("gm-find-on", show);
		if (show) rinput.focus();
	});
	const keys = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			if (e.target === rinput) go(e.metaKey || e.ctrlKey ? replaceAll : replaceNext)();
			else go(e.shiftKey ? findPrevious : findNext)();
		} else if (e.key === "Escape") {
			e.preventDefault();
			closeSearchPanel(view);
			view.focus();
		}
	};
	input.addEventListener("keydown", keys);
	rinput.addEventListener("keydown", keys);

	return {
		dom,
		top: true,
		mount() {
			origin = view.state.selection.main.from;
			// Seed with the selected text, as most editors do.
			const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
			if (sel && !sel.includes("\n")) {
				input.value = sel;
				commit();
			}
			sync();
			input.focus();
			input.select();
		},
		update(u: ViewUpdate) {
			if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((e) => e.is(setSearchQuery)))) sync();
		},
	};
}
