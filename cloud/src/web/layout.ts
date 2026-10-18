// Page shell and styles for the web app.

import type { User, Workspace } from "../accounts";

export interface PageOptions {
	title: string;
	user?: User | null;
	workspaces?: Workspace[];
	current?: Workspace;
	active?: "notes" | "graph" | "history" | "import" | "settings" | "connect";
	flash?: string;
	error?: string;
}

// Styles come from /app.css, built from site/src/styles/app.css with the
// same design tokens as the marketing site and docs.

export function page(o: PageOptions, body: string): Response {
	const ws = o.current;
	const item = (key: PageOptions["active"], href: string, label: string) =>
		`<a href="${href}" class="block rounded-md px-2.5 py-1.5 text-[14px] no-underline ${o.active === key ? "bg-accent-soft text-ink" : "text-muted hover:bg-accent-soft/60 hover:text-ink"}">${label}</a>`;
	const nav = ws
		? item("notes", `/w/${ws.slug}`, "Notes") +
			item("graph", `/w/${ws.slug}/graph`, "Graph") +
			item("history", `/w/${ws.slug}/history`, "History") +
			item("import", `/w/${ws.slug}/import`, "Import") +
			item("settings", `/w/${ws.slug}/settings`, "Settings") +
			item("connect", `/connect`, "Connect apps")
		: o.user
			? item("connect", `/connect`, "Connect apps")
			: "";
	const switcher =
		ws && o.workspaces && o.workspaces.length > 1
			? `<select aria-label="Workspace" class="w-full" onchange="location.href='/w/'+this.value">${o.workspaces
					.map((w) => `<option value="${escape(w.slug)}"${w.id === ws.id ? " selected" : ""}>${escape(w.name)}${w.kind === "team" ? " (team)" : ""}</option>`)
					.join("")}</select>`
			: ws
				? `<p class="px-2.5 text-[13px] text-muted">${escape(ws.name)}</p>`
				: "";
	const me = o.user
		? `<div class="flex items-center gap-2 px-2.5">${o.user.avatar_url ? `<img src="${escape(o.user.avatar_url)}" alt="" class="size-6 rounded-full">` : ""}
			<span class="truncate text-[14px]">${escape(o.user.login)}</span></div>
			<form method="post" action="/logout" class="px-2.5"><button class="plain w-full justify-center" type="submit">Sign out</button></form>`
		: `<a class="btn" href="/login?next=%2Fapp">Sign in with GitHub</a>`;
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(o.title)} · gitmind</title><meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/app.css"></head>
<body class="min-h-screen bg-paper text-ink">
<input id="nav" type="checkbox" class="peer hidden">
<header class="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-paper/90 px-4 py-3 backdrop-blur md:hidden">
	<label for="nav" class="cursor-pointer rounded-md border border-line px-2.5 py-1 text-[14px]">Menu</label>
	<a href="/" class="flex items-center gap-2 font-serif text-[17px] text-ink no-underline">${LOGO}gitmind</a>
</header>
<aside class="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col gap-5 overflow-y-auto border-r border-line bg-paper px-3 py-5 peer-checked:flex md:flex">
	<a href="/" class="flex items-center gap-2 px-2.5 font-serif text-[19px] font-medium text-ink no-underline">${LOGO}gitmind</a>
	${switcher}
	<nav class="flex flex-col gap-0.5">${nav}</nav>
	<nav class="flex flex-col gap-0.5 border-t border-line pt-4">
		<a href="/docs/" class="block rounded-md px-2.5 py-1.5 text-[14px] text-muted no-underline hover:text-ink">Documentation</a>
		<a href="https://github.com/dunkbing/gitmind" class="block rounded-md px-2.5 py-1.5 text-[14px] text-muted no-underline hover:text-ink">GitHub</a>
	</nav>
	<div class="mt-auto flex flex-col gap-3 border-t border-line pt-4">${me}</div>
</aside>
<label for="nav" class="fixed inset-0 z-20 hidden bg-black/30 peer-checked:block md:hidden!"></label>
<div class="md:pl-60"><main class="mx-auto max-w-[1040px] px-5 py-8 md:px-10 md:py-12">
${o.flash ? `<div class="flash">${escape(o.flash)}</div>` : ""}${o.error ? `<div class="flash error">${escape(o.error)}</div>` : ""}${body}
</main></div></body></html>`;
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "default-src 'self'; img-src 'self' https://avatars.githubusercontent.com data:; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "same-origin",
		},
	});
}

// The app icon inline, in the page's accent color.
const LOGO = `<svg viewBox="0 0 512 512" width="22" height="22" aria-hidden="true" class="shrink-0 text-accent"><g fill="none" stroke="currentColor" stroke-linecap="round"><path d="M176 112 V346" stroke-width="44"/><path d="M176 300 C176 210 336 244 336 150" stroke-width="44"/><circle cx="176" cy="404" r="48" stroke-width="40"/></g><g fill="currentColor"><circle cx="176" cy="104" r="58"/><circle cx="336" cy="134" r="58"/></g></svg>`;

export const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
