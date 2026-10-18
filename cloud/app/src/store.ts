// Client-side state: the signed-in user, each workspace's note list, and a
// cache of opened notes, so moving around the app never waits on the
// network for something it has already seen.

import { useSyncExternalStore } from "react";
import { type Hit, type Me, type NoteData, api } from "./api";

interface State {
	me: Me | null;
	notes: Record<string, Hit[] | undefined>; // by workspace slug
	toasts: { id: number; text: string; error?: boolean }[];
}

let state: State = { me: null, notes: {}, toasts: [] };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
	state = { ...state, ...patch };
	listeners.forEach((l) => l());
}

export function useStore<T>(select: (s: State) => T): T {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => select(state),
	);
}

export const getState = () => state;

export async function loadMe() {
	set({ me: await api.me() });
}

const loading = new Map<string, Promise<Hit[]>>();

export function loadNotes(slug: string, force = false): Promise<Hit[]> {
	const have = state.notes[slug];
	if (have && !force) return Promise.resolve(have);
	let p = loading.get(slug);
	if (!p || force) {
		p = api.notes(slug).then((notes) => {
			set({ notes: { ...state.notes, [slug]: notes } });
			return notes;
		});
		p.finally(() => loading.delete(slug));
		loading.set(slug, p);
	}
	return p;
}

// patchNotes updates the cached list after a change made here, so the
// sidebar reflects it at once; a refetch follows to pick up server details.
export function patchNotes(slug: string, f: (notes: Hit[]) => Hit[]) {
	const have = state.notes[slug];
	if (have) set({ notes: { ...state.notes, [slug]: f(have) } });
}

const noteCache = new Map<string, NoteData>();
const noteLoading = new Map<string, Promise<NoteData>>();
const key = (slug: string, path: string) => `${slug}\n${path}`;

export const cachedNote = (slug: string, path: string) => noteCache.get(key(slug, path));

export function loadNote(slug: string, path: string): Promise<NoteData> {
	const k = key(slug, path);
	let p = noteLoading.get(k);
	if (!p) {
		p = api.note(slug, path).then((n) => {
			noteCache.set(k, n);
			if (n.path !== path) noteCache.set(key(slug, n.path), n);
			return n;
		});
		p.finally(() => noteLoading.delete(k));
		noteLoading.set(k, p);
	}
	return p;
}

export function storeNote(slug: string, n: NoteData) {
	noteCache.set(key(slug, n.path), n);
}

export function forgetNote(slug: string, path: string) {
	noteCache.delete(key(slug, path));
}

// prefetch warms the cache when the pointer rests on a link to a note.
export function prefetch(slug: string, path: string) {
	if (!noteCache.has(key(slug, path))) loadNote(slug, path).catch(() => {});
}

let toastId = 0;
export function toast(text: string, error = false) {
	const id = ++toastId;
	set({ toasts: [...state.toasts, { id, text, error }] });
	setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== id) }), error ? 6000 : 2500);
}
