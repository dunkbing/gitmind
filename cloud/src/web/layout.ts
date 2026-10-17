// Page shell and styles for the web app.

import type { User, Workspace } from "../accounts";
import { escape } from "./markdown";

export interface PageOptions {
	title: string;
	user?: User | null;
	workspaces?: Workspace[];
	current?: Workspace;
	active?: "notes" | "graph" | "history" | "import" | "settings" | "connect";
	flash?: string;
	error?: string;
}

const STYLE = `
:root{--bg:#fbfaf8;--fg:#1d1c1a;--muted:#6b6862;--line:#e6e2db;--card:#fff;--accent:#2f6f5e;--accent-fg:#fff;--warn:#a4472e;--chip:#eef3f1;--code:#f3f1ed;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#151514;--fg:#ecebe8;--muted:#a19e97;--line:#2c2b29;--card:#1c1c1a;--accent:#7cc4ad;--accent-fg:#0e1a16;--warn:#e6896d;--chip:#1f2b27;--code:#232320;color-scheme:dark}}
:root[data-theme=dark]{--bg:#151514;--fg:#ecebe8;--muted:#a19e97;--line:#2c2b29;--card:#1c1c1a;--accent:#7cc4ad;--accent-fg:#0e1a16;--warn:#e6896d;--chip:#1f2b27;--code:#232320;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{border-bottom:1px solid var(--line);padding:10px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header .brand{font-weight:650;color:var(--fg)}header nav{display:flex;gap:4px;flex-wrap:wrap;flex:1}
header nav a{padding:4px 10px;border-radius:6px;color:var(--muted)}header nav a.on{background:var(--chip);color:var(--fg)}
header .me{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:14px}header img{width:24px;height:24px;border-radius:50%}
select,input,textarea,button{font:inherit;color:inherit}
select,input[type=text],input[type=search],textarea{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 9px}
textarea{width:100%;min-height:55vh;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
button,.btn{background:var(--accent);color:var(--accent-fg);border:0;border-radius:6px;padding:6px 13px;cursor:pointer;display:inline-block}
button.plain,.btn.plain{background:transparent;color:var(--fg);border:1px solid var(--line)}button.danger{background:var(--warn);color:#fff}
main{max-width:1060px;margin:0 auto;padding:22px 20px 60px}
.flash{background:var(--chip);border:1px solid var(--line);padding:9px 13px;border-radius:8px;margin-bottom:16px}
.error{border-color:var(--warn);color:var(--warn)}
.cols{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:28px}@media (max-width:820px){.cols{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.hits{list-style:none;padding:0;margin:0}.hits li{padding:11px 0;border-bottom:1px solid var(--line)}
.hits .meta,.muted{color:var(--muted);font-size:13px}.hits .snip{font-size:14px;margin-top:3px;overflow-wrap:anywhere}
.tag{background:var(--chip);border-radius:4px;padding:0 5px;font-size:13px;color:var(--accent)}
.cat{background:var(--chip);border-radius:4px;padding:0 6px;font-size:12px;font-weight:600;text-transform:lowercase;margin-right:2px}
.badge{border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px;color:var(--muted);margin-left:6px}
.note h1{margin:0 0 4px}.note .body{margin-top:18px;overflow-wrap:anywhere}.note pre{background:var(--code);padding:10px 12px;border-radius:8px;overflow-x:auto}
.note code{background:var(--code);padding:1px 4px;border-radius:4px;font-size:13px}.note pre code{padding:0;background:none}
.wiki{border-bottom:1px dashed var(--accent)}.wiki.missing{color:var(--warn);border-color:var(--warn)}
blockquote{border-left:3px solid var(--line);margin:8px 0;padding:2px 12px;color:var(--muted)}
.side h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:18px 0 6px}.side ul{padding-left:18px;margin:0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}form.inline{display:inline}
details summary{cursor:pointer;color:var(--muted);margin:10px 0 4px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}
.wrap{overflow-x:auto}pre.box{background:var(--code);padding:10px 12px;border-radius:8px;overflow-x:auto;font-size:13px}
.hero{max-width:640px;margin:8vh auto 0}.hero h1{font-size:34px;line-height:1.2;margin:0 0 12px}
`;

export function page(o: PageOptions, body: string): Response {
	const ws = o.current;
	const tab = (key: PageOptions["active"], href: string, label: string) => `<a href="${href}" class="${o.active === key ? "on" : ""}">${label}</a>`;
	const nav = ws
		? tab("notes", `/w/${ws.slug}`, "Notes") +
			tab("graph", `/w/${ws.slug}/graph`, "Graph") +
			tab("history", `/w/${ws.slug}/history`, "History") +
			tab("import", `/w/${ws.slug}/import`, "Import") +
			tab("settings", `/w/${ws.slug}/settings`, "Settings") +
			tab("connect", `/connect`, "Connect")
		: o.user
			? tab("connect", `/connect`, "Connect")
			: "";
	const switcher =
		ws && o.workspaces && o.workspaces.length > 1
			? `<select aria-label="Workspace" onchange="location.href='/w/'+this.value">${o.workspaces
					.map((w) => `<option value="${escape(w.slug)}"${w.id === ws.id ? " selected" : ""}>${escape(w.name)}${w.kind === "team" ? " (team)" : ""}</option>`)
					.join("")}</select>`
			: "";
	const me = o.user
		? `<span class="me">${o.user.avatar_url ? `<img src="${escape(o.user.avatar_url)}" alt="">` : ""}${escape(o.user.login)}
			<form class="inline" method="post" action="/logout"><button class="plain" type="submit">Sign out</button></form></span>`
		: `<a class="btn" href="/login">Sign in with GitHub</a>`;
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(o.title)} · memory-go</title><style>${STYLE}</style></head><body>
<header><a class="brand" href="/">memory-go</a>${switcher}<nav>${nav}</nav>${me}</header>
<main>${o.flash ? `<div class="flash">${escape(o.flash)}</div>` : ""}${o.error ? `<div class="flash error">${escape(o.error)}</div>` : ""}${body}</main></body></html>`;
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "same-origin",
		},
	});
}

export { escape };
