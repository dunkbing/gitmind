// A minimal client-side router: the URL is the state, links and navigate()
// push history entries, and every view re-renders from the current location.

import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
addEventListener("popstate", notify);

export function navigate(to: string, opts: { replace?: boolean } = {}) {
	if (to === location.pathname + location.search) return;
	if (opts.replace) history.replaceState(null, "", to);
	else history.pushState(null, "", to);
	notify();
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};
const snapshot = () => location.pathname + location.search;

export function useLocation(): URL {
	const href = useSyncExternalStore(subscribe, snapshot);
	return new URL(href, location.origin);
}

export type Route =
	| { view: "home"; slug: string }
	| { view: "note"; slug: string; path: string }
	| { view: "search"; slug: string }
	| { view: "graph"; slug: string }
	| { view: "history"; slug: string }
	| { view: "import"; slug: string }
	| { view: "settings"; slug: string }
	| { view: "connect"; slug?: string }
	| { view: "unknown" };

export function parseRoute(url: URL): Route {
	if (url.pathname === "/connect") return { view: "connect" };
	const m = /^\/w\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
	if (!m) return { view: "unknown" };
	const slug = decodeURIComponent(m[1]);
	const rest = m[2] ?? "";
	if (rest === "") return { view: "home", slug };
	if (rest.startsWith("n/")) return { view: "note", slug, path: rest.slice(2).split("/").map(decodeURIComponent).join("/") };
	if (["search", "graph", "history", "import", "settings"].includes(rest)) return { view: rest as "search", slug };
	return { view: "unknown" };
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
export const noteUrl = (slug: string, path: string) => `/w/${encodeURIComponent(slug)}/n/${enc(path)}`;
export const wsUrl = (slug: string, sub = "") => `/w/${encodeURIComponent(slug)}${sub ? "/" + sub : ""}`;

// Link navigates without reloading; modified clicks (new tab) work as usual.
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
	const click = (e: MouseEvent<HTMLAnchorElement>) => {
		onClick?.(e);
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		if (!href.startsWith("/w/") && href !== "/connect") return; // pages outside the app
		e.preventDefault();
		navigate(href);
	};
	return <a href={href} onClick={click} {...rest} />;
}
