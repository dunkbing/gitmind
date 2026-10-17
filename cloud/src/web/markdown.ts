// A small, safe Markdown renderer for note bodies: everything is escaped
// first, then a fixed set of constructs is turned into HTML. [[Wiki links]]
// become links through resolveLink.

export const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderMarkdown(md: string, resolveLink: (target: string) => string | null): string {
	const lines = md.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let list: "ul" | "ol" | null = null;
	let para: string[] = [];
	let code: string[] | null = null;

	const flushPara = () => {
		if (para.length) out.push(`<p>${para.map((l) => inline(l, resolveLink)).join("<br>")}</p>`);
		para = [];
	};
	const closeList = () => {
		if (list) out.push(`</${list}>`);
		list = null;
	};

	for (const line of lines) {
		if (code) {
			if (/^\s*(```|~~~)/.test(line)) {
				out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
				code = null;
			} else code.push(line);
			continue;
		}
		if (/^\s*(```|~~~)/.test(line)) {
			flushPara();
			closeList();
			code = [];
			continue;
		}
		const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading) {
			flushPara();
			closeList();
			const level = Math.min(heading[1].length + 1, 6); // the page title is the h1
			out.push(`<h${level}>${inline(heading[2], resolveLink)}</h${level}>`);
			continue;
		}
		const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (item) {
			flushPara();
			const kind = /\d/.test(item[1]) ? "ol" : "ul";
			if (list !== kind) {
				closeList();
				out.push(`<${kind}>`);
				list = kind;
			}
			let text = item[2];
			const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
			const obs = /^\[([^\][]+)\]\s+(.*)$/.exec(text);
			if (task) text = `<input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}> ${inline(task[2], resolveLink)}`;
			else if (obs) text = `<span class="cat">${escape(obs[1])}</span> ${inline(obs[2], resolveLink)}`;
			else text = inline(text, resolveLink);
			out.push(`<li>${text}</li>`);
			continue;
		}
		if (/^\s*>/.test(line)) {
			flushPara();
			closeList();
			out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""), resolveLink)}</blockquote>`);
			continue;
		}
		if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
			flushPara();
			closeList();
			out.push("<hr>");
			continue;
		}
		if (!line.trim()) {
			flushPara();
			closeList();
			continue;
		}
		closeList();
		para.push(line);
	}
	if (code) out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
	flushPara();
	closeList();
	return out.join("\n");
}

function inline(text: string, resolveLink: (target: string) => string | null): string {
	// Protect code spans, then escape, then apply the rest.
	const spans: string[] = [];
	text = text.replace(/`([^`]+)`/g, (_, c) => {
		spans.push(`<code>${escape(c)}</code>`);
		return `\u0000${spans.length - 1}\u0000`;
	});
	let s = escape(text);
	s = s.replace(/\[\[([^[\]|#]+)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g, (_, target: string, _h, alias?: string) => {
		const label = alias || target;
		const href = resolveLink(unescapeHtml(target.trim()));
		return href ? `<a class="wiki" href="${href}">${label}</a>` : `<span class="wiki missing" title="No such note yet">${label}</span>`;
	});
	s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="${url}" rel="noopener noreferrer">${label}</a>`);
	s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
	s = s.replace(/(^|[\s(])#(\p{L}[\p{L}\p{N}_/-]*)/gu, '$1<span class="tag">#$2</span>');
	return s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

const unescapeHtml = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
