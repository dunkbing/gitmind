// Reads and writes a workspace's git repository over smart HTTP with
// isomorphic-git, keeping everything in memory. Only the remote URL and a
// token are needed, so this works against Cloudflare Artifacts and, in tests,
// any git HTTP server.

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memfs";

export interface Remote {
	url: string;
	// Returns git credentials, minting a fresh token when needed.
	auth: () => Promise<{ username: string; password: string }>;
}

export interface FileChange {
	path: string;
	content: string | null; // null deletes the file
}

export interface Author {
	name: string;
	email: string;
}

export class ConflictError extends Error {
	constructor() {
		super("the remote moved on; fetch and retry");
	}
}

const DIR = "/repo";
const BRANCH = "main";

// Session is a fetched copy of the remote's tip, ready to commit on top of.
export class Session {
	private constructor(
		private remote: Remote,
		private fs: MemoryFS,
		public head: string | null,
		// Every file at head (all files, not just notes), path → blob oid.
		public blobs: Map<string, string>,
		// When head was committed, in ms since epoch.
		public headTime = 0,
	) {}

	static async open(remote: Remote): Promise<Session> {
		const fs = new MemoryFS();
		await git.init({ fs, dir: DIR, defaultBranch: BRANCH });
		await git.addRemote({ fs, dir: DIR, remote: "origin", url: remote.url });
		const auth = await remote.auth();
		const refs = await git.listServerRefs({ http, url: remote.url, prefix: `refs/heads/${BRANCH}`, onAuth: () => auth });
		const tip = refs.find((r) => r.ref === `refs/heads/${BRANCH}`)?.oid ?? null;
		const s = new Session(remote, fs, null, new Map());
		if (tip) {
			await git.fetch({
				fs, http, dir: DIR, remote: "origin", ref: BRANCH, singleBranch: true, depth: 1, tags: false,
				onAuth: () => auth,
			});
			s.head = tip;
			const { commit } = await git.readCommit({ fs, dir: DIR, oid: tip });
			s.headTime = commit.committer.timestamp * 1000;
			for (const [path, oid] of await listTree(fs, tip)) s.blobs.set(path, oid);
		}
		return s;
	}

	// remoteHead asks the server for the branch tip, to tell whether this
	// session is still current.
	static async remoteHead(remote: Remote): Promise<string | null> {
		const auth = await remote.auth();
		const refs = await git.listServerRefs({ http, url: remote.url, prefix: `refs/heads/${BRANCH}`, onAuth: () => auth });
		return refs.find((r) => r.ref === `refs/heads/${BRANCH}`)?.oid ?? null;
	}

	// log fetches the branch's recent history: newest first, with the files
	// each commit changed (first parent only).
	static async log(remote: Remote, limit: number): Promise<{ oid: string; message: string; author: string; time: number; files: string[] }[]> {
		const fs = new MemoryFS();
		await git.init({ fs, dir: DIR, defaultBranch: BRANCH });
		await git.addRemote({ fs, dir: DIR, remote: "origin", url: remote.url });
		const auth = await remote.auth();
		if (!(await Session.remoteHead(remote))) return [];
		await git.fetch({ fs, http, dir: DIR, remote: "origin", ref: BRANCH, singleBranch: true, depth: limit + 1, tags: false, onAuth: () => auth });
		const commits = await git.log({ fs, dir: DIR, ref: `refs/remotes/origin/${BRANCH}`, depth: limit });
		const out = [];
		for (const c of commits) {
			const parent = c.commit.parent[0];
			const files: string[] = [];
			if (parent) {
				try {
					const [now, before] = [await listTree(fs, c.oid), await listTree(fs, parent)];
					for (const [p, oid] of now) if (before.get(p) !== oid) files.push(p);
					for (const p of before.keys()) if (!now.has(p)) files.push(p);
				} catch {
					// the parent is beyond the fetched depth
				}
			}
			out.push({ oid: c.oid, message: c.commit.message.trim(), author: c.commit.author.name, time: c.commit.author.timestamp * 1000, files });
		}
		return out;
	}

	async read(path: string): Promise<string | null> {
		const oid = this.blobs.get(path);
		if (!oid) return null;
		const { blob } = await git.readBlob({ fs: this.fs, dir: DIR, oid });
		return new TextDecoder().decode(blob);
	}

	// commit writes changes on top of head and pushes them. It throws
	// ConflictError when someone else pushed first; the session is then stale.
	async commit(changes: FileChange[], message: string, author: Author): Promise<string> {
		if (changes.length === 0) throw new Error("nothing to commit");
		const blobs = new Map(this.blobs);
		for (const c of changes) {
			if (c.content === null) blobs.delete(c.path);
			else blobs.set(c.path, await git.writeBlob({ fs: this.fs, dir: DIR, blob: new TextEncoder().encode(c.content) }));
		}
		const tree = await writeTree(this.fs, blobs);
		const now = Math.floor(Date.now() / 1000);
		const who = { ...author, timestamp: now, timezoneOffset: 0 };
		const oid = await git.writeCommit({
			fs: this.fs,
			dir: DIR,
			commit: { message: message.endsWith("\n") ? message : message + "\n", tree, parent: this.head ? [this.head] : [], author: who, committer: who },
		});
		await git.writeRef({ fs: this.fs, dir: DIR, ref: `refs/heads/${BRANCH}`, value: oid, force: true });
		const auth = await this.remote.auth();
		let result;
		try {
			result = await git.push({ fs: this.fs, http, dir: DIR, url: this.remote.url, ref: BRANCH, remoteRef: BRANCH, onAuth: () => auth });
		} catch (e) {
			if (isRejection(e)) throw new ConflictError();
			throw e;
		}
		if (!result.ok || result.refs[`refs/heads/${BRANCH}`]?.ok === false) {
			const error = result.error ?? result.refs[`refs/heads/${BRANCH}`]?.error ?? "";
			if (/non-fast-forward|fetch first|rejected|stale|failed to update/i.test(error)) throw new ConflictError();
			throw new Error(`push failed: ${error}`);
		}
		this.head = oid;
		this.headTime = now * 1000;
		this.blobs = blobs;
		return oid;
	}
}

function isRejection(e: unknown): boolean {
	const err = e as { code?: string; message?: string };
	return err?.code === "PushRejectedError" || /non-fast-forward|fetch first|not a simple fast-forward/i.test(err?.message ?? "");
}

async function listTree(fs: MemoryFS, commit: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const { commit: c } = await git.readCommit({ fs, dir: DIR, oid: commit });
	const walk = async (treeOid: string, prefix: string) => {
		const { tree } = await git.readTree({ fs, dir: DIR, oid: treeOid });
		for (const e of tree) {
			const p = prefix + e.path;
			if (e.type === "tree") await walk(e.oid, p + "/");
			else if (e.type === "blob") out.set(p, e.oid);
		}
	};
	await walk(c.tree, "");
	return out;
}

async function writeTree(fs: MemoryFS, blobs: Map<string, string>): Promise<string> {
	type Dir = { files: Map<string, string>; dirs: Map<string, Dir> };
	const root: Dir = { files: new Map(), dirs: new Map() };
	for (const [path, oid] of blobs) {
		const parts = path.split("/");
		let d = root;
		for (const seg of parts.slice(0, -1)) {
			if (!d.dirs.has(seg)) d.dirs.set(seg, { files: new Map(), dirs: new Map() });
			d = d.dirs.get(seg)!;
		}
		d.files.set(parts[parts.length - 1], oid);
	}
	const write = async (d: Dir): Promise<string> => {
		const entries: { mode: string; path: string; oid: string; type: "blob" | "tree" }[] = [];
		for (const [name, oid] of d.files) entries.push({ mode: "100644", path: name, oid, type: "blob" });
		for (const [name, sub] of d.dirs) entries.push({ mode: "040000", path: name, oid: await write(sub), type: "tree" });
		return git.writeTree({ fs, dir: DIR, tree: entries });
	};
	return write(root);
}
