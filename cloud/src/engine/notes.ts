// Note format and text helpers, ported from the Go engine
// (internal/notes/notes.go) so notes written by the CLI and the cloud are
// identical. Keep the two in sync.

export interface Note {
	path: string; // slash-separated, relative to the repo root, ends in .md
	title: string;
	tags: string[];
	created: string | null; // RFC 3339, second precision, UTC
	pinned: boolean;
	locked: boolean;
	extra: string[]; // unknown frontmatter lines, preserved as-is
	body: string;
}

export const permalink = (p: string) => p.replace(/\.md$/, "");

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function parse(path: string, data: string): Note {
	const n: Note = {
		path,
		title: baseName(path).replace(/\.md$/, ""),
		tags: [],
		created: null,
		pinned: false,
		locked: false,
		extra: [],
		body: "",
	};
	const text = data.replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) {
		n.body = text;
		return n;
	}
	const rest = text.slice(4);
	let fm: string;
	const end = rest.indexOf("\n---\n");
	if (end >= 0) {
		fm = rest.slice(0, end);
		n.body = rest.slice(end + 5);
	} else if (rest.endsWith("\n---")) {
		fm = rest.slice(0, -4);
	} else {
		n.body = text;
		return n;
	}
	n.body = n.body.replace(/^\n+/, "");

	let key = "";
	for (const line of fm.split("\n")) {
		const trimmed = line.trim();
		if (key !== "" && (line.startsWith(" ") || line.startsWith("\t") || trimmed.startsWith("- "))) {
			if (key === "tags") n.tags = appendTag(n.tags, trimmed.replace(/^- /, ""));
			else n.extra.push(line);
			continue;
		}
		const colon = line.indexOf(":");
		if (colon < 0) {
			n.extra.push(line);
			key = "";
			continue;
		}
		key = line.slice(0, colon).trim();
		const v = line.slice(colon + 1).trim();
		switch (key) {
			case "title":
				if (v !== "") n.title = unquote(v);
				break;
			case "tags":
				n.tags = [];
				for (const t of v.replace(/^\[+|\]+$/g, "").split(",")) n.tags = appendTag(n.tags, t);
				break;
			case "created": {
				const t = unquote(v);
				if (!Number.isNaN(Date.parse(t))) n.created = t;
				break;
			}
			case "pinned":
				n.pinned = isTrue(v);
				break;
			case "locked":
				n.locked = isTrue(v);
				break;
			default:
				n.extra.push(line);
		}
	}
	return n;
}

export function format(n: Note): string {
	let b = "---\n";
	b += `title: ${yamlString(n.title)}\n`;
	if (n.tags.length > 0) b += `tags: [${n.tags.map(yamlString).join(", ")}]\n`;
	if (n.created) b += `created: ${n.created}\n`;
	if (n.pinned) b += "pinned: true\n";
	if (n.locked) b += "locked: true\n";
	for (const line of n.extra) b += line + "\n";
	b += "---\n\n";
	const body = n.body.replace(/^\n+/, "");
	b += body;
	if (!body.endsWith("\n")) b += "\n";
	return b;
}

export const nowRFC3339 = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function normalizeTags(tags: string[]): string[] {
	let out: string[] = [];
	for (const t of tags) out = appendTag(out, t);
	return out;
}

function appendTag(tags: string[], t: string): string[] {
	const tag = unquote(t.trim()).replace(/^#/, "").toLowerCase();
	if (tag === "" || tags.includes(tag)) return tags;
	return [...tags, tag];
}

const letterFolds: Record<string, string> = {
	đ: "d", ð: "d", ł: "l", ø: "o", ı: "i", ß: "ss", æ: "ae", œ: "oe", þ: "th",
};

// slugify turns a title into a file-name-safe, lowercase, hyphenated slug.
// Accents are removed ("Tiếng Việt" → "tieng-viet") so macOS and Linux agree
// on file names; non-Latin scripts are kept, in NFC form.
export function slugify(s: string): string {
	let b = "";
	let dash = false;
	for (const r of s.toLowerCase().normalize("NFD")) {
		if (/\p{Mn}/u.test(r)) continue;
		if (letterFolds[r]) {
			b += letterFolds[r];
			dash = false;
		} else if (/[\p{L}\p{N}]/u.test(r)) {
			b += r;
			dash = false;
		} else if (!dash && b.length > 0) {
			b += "-";
			dash = true;
		}
	}
	let slug = b.replace(/-+$/, "").normalize("NFC");
	const runes = [...slug];
	if (runes.length > 80) slug = runes.slice(0, 80).join("").replace(/-+$/, "");
	return slug === "" ? "note" : slug;
}

// cleanDir normalizes a user-supplied directory into slugified segments; ""
// is the root.
export function cleanDir(dir: string): string {
	const d = dir.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (d === "") return "";
	const segs: string[] = [];
	for (const seg of d.split("/")) {
		if (seg === "..") throw new Error(`invalid directory "${dir}"`);
		if (seg === "" || seg === ".") continue;
		segs.push(slugify(seg));
	}
	return segs.join("/");
}

// validPath rejects paths that escape the root, touch hidden files or aren't
// Markdown, mirroring Store.abs in Go.
export function validPath(p: string): string {
	const clean = p.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".").join("/");
	if (clean === "" || p.startsWith("/") || !clean.endsWith(".md")) throw new Error(`invalid note path "${p}"`);
	for (const seg of clean.split("/")) {
		if (seg === ".." || seg.startsWith(".")) throw new Error(`invalid note path "${p}"`);
	}
	return clean.normalize("NFC");
}

export interface Link {
	target: string;
	relation: string;
}

const linkRe = /\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|[^[\]]*)?\]\]/g;

export const isFence = (line: string) => {
	const t = line.trim();
	return t.startsWith("```") || t.startsWith("~~~");
};

export function unfencedLines(body: string): string[] {
	const lines: string[] = [];
	let fenced = false;
	for (const line of body.split("\n")) {
		if (isFence(line)) {
			fenced = !fenced;
			continue;
		}
		if (!fenced) lines.push(line);
	}
	return lines;
}

export function links(body: string): Link[] {
	const out: Link[] = [];
	const seen = new Set<string>();
	for (const line of unfencedLines(body)) {
		const trimmed = line.trim();
		let i = 0;
		for (const m of line.matchAll(linkRe)) {
			const l: Link = { target: m[1].trim(), relation: "" };
			if (i === 0 && trimmed.startsWith("- ")) l.relation = relation(line.slice(0, m.index).trim());
			i++;
			const key = l.target + "\0" + l.relation;
			if (l.target !== "" && !seen.has(key)) {
				seen.add(key);
				out.push(l);
			}
		}
	}
	return out;
}

function relation(prefix: string): string {
	const r = prefix.replace(/^-/, "").trim();
	if (r === "" || /[[\]()#:.,]/.test(r) || r.split(/\s+/).length > 4) return "";
	return r.toLowerCase();
}

// linkTarget maps a link target to the note path it names ("" when it has no
// directory) and the slug of its file name.
export function linkTarget(target: string): { notePath: string; slug: string } {
	const t = target.trim().normalize("NFC").replace(/\.md$/, "");
	const i = t.lastIndexOf("/");
	const dir = i >= 0 ? t.slice(0, i + 1) : "";
	const slug = slugify(t.slice(i + 1));
	try {
		const d = cleanDir(dir);
		if (d !== "") return { notePath: `${d}/${slug}.md`, slug };
	} catch {
		// fall through: treat as a bare name
	}
	return { notePath: "", slug };
}

export function summary(body: string): string {
	for (let line of body.split("\n")) {
		line = line.trim();
		if (line === "" || line.startsWith("#") || line.startsWith("```") || line === "---") continue;
		const r = [...line];
		return r.length > 160 ? r.slice(0, 159).join("") + "…" : line;
	}
	return "";
}

export interface Observation {
	category: string;
	text: string;
}

const observationRe = /^\s*[-*]\s+\[([^[\]]+)\]\s+(.+)$/;
const inlineTagRe = /(?:^|[\s(])#(\p{L}[\p{L}\p{N}_/-]*)/gu;

export function observations(body: string): Observation[] {
	const out: Observation[] = [];
	for (const line of unfencedLines(body)) {
		const m = observationRe.exec(line);
		if (!m) continue;
		const category = m[1].trim().toLowerCase();
		if (category === "" || category === "x") continue;
		out.push({ category, text: m[2].trim() });
	}
	return out;
}

// currentObservations is observations without those under a "History"
// heading, where replaced facts are kept for the record.
export function currentObservations(body: string): Observation[] {
	return observations(splitHistory(body).current);
}

// splitHistory separates the parts of body under a "History" heading (any
// level, with its subsections), where replaced facts are kept, from the rest.
export function splitHistory(body: string): { current: string; history: string } {
	const lines = body.split("\n");
	const mask = historyLines(lines);
	return {
		current: lines.filter((_, i) => !mask[i]).join("\n"),
		history: lines.filter((_, i) => mask[i]).join("\n"),
	};
}

// historyLines marks the lines of History sections, headings included.
function historyLines(lines: string[]): boolean[] {
	let history = false;
	let level = 0;
	let fenced = false;
	return lines.map((line) => {
		const m = headingRe.exec(line);
		if (isFence(line)) fenced = !fenced;
		else if (m && !fenced && (!history || m[1].length <= level)) {
			history = isHistoryHeading(m[2]);
			level = m[1].length;
		}
		return history;
	});
}

const isHistoryHeading = (text: string) => text.trim().toLowerCase() === "history";
const isListItem = (line: string) => line.startsWith("- ") || line.startsWith("* ");

// supersede replaces the current fact matching old with replacement, and
// keeps the old fact under the note's "History" heading (added at the end if
// missing), newest first, marked with date. An empty replacement retires the
// fact. old must match exactly one current fact line, ignoring the list
// marker, case, spacing and trailing #tags; its category may be left out.
export function supersede(body: string, old: string, replacement: string, date: string): string {
	const want = factKey(old);
	if (want.text === "") throw new Error("find_text: the fact to replace is required");
	const lines = body.replace(/\n+$/, "").split("\n");
	const history = historyLines(lines);
	const matches: number[] = [];
	let fenced = false;
	lines.forEach((line, i) => {
		if (isFence(line)) {
			fenced = !fenced;
			return;
		}
		if (fenced || history[i] || !isListItem(line.trim())) return;
		if (factMatches(factKey(line), want)) matches.push(i);
	});
	if (matches.length === 0) {
		let msg = `no current fact matches "${old.trim()}"`;
		const obs = currentObservations(body);
		if (obs.length) msg += "; the note's current facts:\n" + obs.slice(0, 15).map((o) => `- [${o.category}] ${o.text}`).join("\n");
		throw new Error(msg);
	}
	if (matches.length > 1) throw new Error(`${matches.length} current facts match "${old.trim()}"; quote more of the one to replace`);

	const i = matches[0];
	const oldLine = lines[i];
	const indent = oldLine.slice(0, oldLine.length - oldLine.replace(/^[ \t]+/, "").length);
	const marker = oldLine.trim().slice(0, 2);
	const out = lines.slice(0, i);
	const r = replacement.replace(/^\n+|\n+$/g, "");
	if (r.trim() !== "") {
		for (let l of r.split("\n")) {
			const t = l.trim();
			if (t !== "" && !isListItem(t)) l = marker + t;
			out.push(indent + l.replace(/^[ \t]+/, ""));
		}
	}
	out.push(...lines.slice(i + 1));
	const verb = replacement.trim() === "" ? "removed" : "replaced";
	return addToHistory(out, `- ${oldLine.trim().slice(2).trim()} (${verb} ${date})`);
}

// addToHistory puts entry first under the History heading, or adds the
// heading at the end.
function addToHistory(lines: string[], entry: string): string {
	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		if (isFence(lines[i])) {
			fenced = !fenced;
			continue;
		}
		const m = headingRe.exec(lines[i]);
		if (!m || fenced || !isHistoryHeading(m[2])) continue;
		let at = i + 1;
		while (at < lines.length && lines[at].trim() === "") at++;
		const out = [...lines.slice(0, i + 1), "", entry];
		if (at < lines.length) {
			if (!isListItem(lines[at].trim())) out.push("");
			out.push(...lines.slice(at));
		}
		return out.join("\n") + "\n";
	}
	let body = lines.join("\n").replace(/\n+$/, "");
	if (body.trim() !== "") body += "\n\n";
	return body + "## History\n\n" + entry + "\n";
}

const trailingTagsRe = /(?:\s+#\p{L}[\p{L}\p{N}_/-]*)+$/u;
const categoryRe = /^\[([^[\]]+)\]\s*/;

// factKey reduces a fact line for matching: lower case, single spaces,
// without list marker, category or trailing #tags.
function factKey(line: string): { category: string; text: string } {
	let s = line.trim();
	if (isListItem(s)) s = s.slice(2).trim();
	let category = "";
	const m = categoryRe.exec(s);
	if (m) {
		category = m[1].trim().toLowerCase();
		s = s.slice(m[0].length);
	}
	s = s.replace(trailingTagsRe, "");
	return { category, text: s.split(/\s+/).filter(Boolean).join(" ").toLowerCase() };
}

const factMatches = (f: { category: string; text: string }, want: { category: string; text: string }) =>
	f.text === want.text && (want.category === "" || f.category === want.category);

const FACT_STOP_WORDS = new Set([
	"the", "and", "for", "with", "from", "into", "that", "this", "not", "use", "uses", "using", "are", "was", "were", "has",
	"have", "its", "our", "but", "than", "then", "when", "which", "all", "any", "can", "via", "per", "only", "now", "instead",
]);

// factWords are the words of a fact that say what it's about: lower case,
// without its category, #tags, short words and common words, and with a
// plural "s" dropped.
export function factWords(text: string): string[] {
	const words: string[] = [];
	for (let w of factKey(text).text.split(/[^\p{L}\p{N}]+/u)) {
		if ([...w].length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
		if ([...w].length < 3 || FACT_STOP_WORDS.has(w) || words.includes(w)) continue;
		words.push(w);
	}
	return words;
}

// factOverlap is how much two facts are about the same thing, from 0 to 1:
// the share of the shorter one's words that the other has too. It's 0 when
// they share fewer than two words, unless one has only one or two words.
export function factOverlap(a: string[], b: string[]): number {
	if (!a.length || !b.length) return 0;
	const set = new Set(a);
	const shared = b.filter((w) => set.has(w)).length;
	const shorter = Math.min(a.length, b.length);
	if (shared < 2 && !(shared === 1 && shorter <= 2)) return 0;
	return shared / shorter;
}

export function inlineTags(body: string): string[] {
	let tags: string[] = [];
	for (const line of unfencedLines(body)) {
		for (const m of line.matchAll(inlineTagRe)) tags = appendTag(tags, m[1].replace(/[/-]+$/, ""));
	}
	return tags;
}

// rewriteLinks replaces the target of every [[link]] outside code fences for
// which repl returns a string, keeping #heading and |alias.
export function rewriteLinks(body: string, repl: (target: string) => string | null): { body: string; count: number } {
	const lines = body.split("\n");
	let count = 0;
	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (isFence(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		let out = "";
		let last = 0;
		for (const m of line.matchAll(linkRe)) {
			const start = m.index! + 2;
			const end = start + m[1].length;
			const r = repl(m[1].trim());
			if (r !== null) {
				out += line.slice(last, start) + r;
				last = end;
				count++;
			}
		}
		if (last > 0) lines[i] = out + line.slice(last);
	}
	return { body: lines.join("\n"), count };
}

const headingRe = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;

// replaceSection replaces what's under the heading named section up to the
// next heading of the same or higher level; when none matches it appends a
// new "## section" and reports added.
export function replaceSection(body: string, section: string, content: string): { body: string; added: boolean } {
	const want = section.trim().replace(/^#+/, "").trim().toLowerCase();
	if (want === "") throw new Error("section heading is required");
	content = content.replace(/^\n+|\n+$/g, "");
	const lines = body.replace(/\n+$/, "").split("\n");
	const headings: { line: number; level: number }[] = [];
	const matches: { line: number; level: number }[] = [];
	let fenced = false;
	lines.forEach((line, i) => {
		if (isFence(line)) {
			fenced = !fenced;
			return;
		}
		const m = headingRe.exec(line);
		if (m && !fenced) {
			const h = { line: i, level: m[1].length };
			headings.push(h);
			if (m[2].toLowerCase() === want) matches.push(h);
		}
	});
	if (matches.length === 0) {
		const added = body.replace(/\n+$/, "") + "\n\n## " + section.trim() + "\n\n" + content + "\n";
		return { body: added.replace(/^\n+/, ""), added: true };
	}
	if (matches.length > 1) throw new Error(`${matches.length} headings are named "${section}"; make them unique first`);
	const start = matches[0];
	let end = lines.length;
	for (const h of headings) {
		if (h.line > start.line && h.level <= start.level) {
			end = h.line;
			break;
		}
	}
	const out = [...lines.slice(0, start.line + 1), ""];
	if (content !== "") out.push(content);
	if (end < lines.length) out.push("", ...lines.slice(end));
	return { body: out.join("\n") + "\n", added: false };
}

function isTrue(v: string): boolean {
	return ["true", "yes", "on"].includes(unquote(v.trim()).toLowerCase());
}

function yamlString(s: string): string {
	if (s === "" || /[:#[\]{},&*!|>'"%@`]/.test(s) || s.trim() !== s) return JSON.stringify(s);
	return s;
}

function unquote(s: string): string {
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
		try {
			return JSON.parse(s);
		} catch {
			return s;
		}
	}
	if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
	return s;
}
