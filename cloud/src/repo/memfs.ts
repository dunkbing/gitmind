// A minimal in-memory file system implementing the promise API isomorphic-git
// needs, since Workers have no disk.

type Entry = { kind: "file"; data: Uint8Array; mtimeMs: number } | { kind: "dir"; mtimeMs: number };

class FsError extends Error {
	constructor(
		public code: string,
		path: string,
	) {
		super(`${code}: ${path}`);
	}
}

const norm = (p: string) => "/" + p.split("/").filter((s) => s && s !== ".").join("/");
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

class Stats {
	constructor(private e: Entry) {}
	get type() {
		return this.e.kind === "file" ? "file" : "dir";
	}
	get mode() {
		return this.e.kind === "file" ? 0o100644 : 0o040000;
	}
	get size() {
		return this.e.kind === "file" ? this.e.data.byteLength : 0;
	}
	get mtimeMs() {
		return this.e.mtimeMs;
	}
	get ctimeMs() {
		return this.e.mtimeMs;
	}
	ino = 0;
	uid = 0;
	gid = 0;
	dev = 0;
	isFile() {
		return this.e.kind === "file";
	}
	isDirectory() {
		return this.e.kind === "dir";
	}
	isSymbolicLink() {
		return false;
	}
}

export class MemoryFS {
	private entries = new Map<string, Entry>([["/", { kind: "dir", mtimeMs: Date.now() }]]);

	promises = {
		readFile: async (path: string, opts?: { encoding?: string } | string) => {
			const e = this.entries.get(norm(path));
			if (!e) throw new FsError("ENOENT", path);
			if (e.kind !== "file") throw new FsError("EISDIR", path);
			const enc = typeof opts === "string" ? opts : opts?.encoding;
			return enc ? new TextDecoder().decode(e.data) : e.data;
		},
		writeFile: async (path: string, data: Uint8Array | string) => {
			const p = norm(path);
			const parent = this.entries.get(parentOf(p));
			if (!parent || parent.kind !== "dir") throw new FsError("ENOENT", path);
			const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
			this.entries.set(p, { kind: "file", data: bytes, mtimeMs: Date.now() });
		},
		unlink: async (path: string) => {
			const p = norm(path);
			const e = this.entries.get(p);
			if (!e) throw new FsError("ENOENT", path);
			if (e.kind !== "file") throw new FsError("EISDIR", path);
			this.entries.delete(p);
		},
		readdir: async (path: string) => {
			const p = norm(path);
			const e = this.entries.get(p);
			if (!e) throw new FsError("ENOENT", path);
			if (e.kind !== "dir") throw new FsError("ENOTDIR", path);
			const prefix = p === "/" ? "/" : p + "/";
			const names = new Set<string>();
			for (const key of this.entries.keys()) {
				if (key !== p && key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]);
			}
			return [...names];
		},
		mkdir: async (path: string) => {
			const p = norm(path);
			if (this.entries.has(p)) throw new FsError("EEXIST", path);
			const parent = this.entries.get(parentOf(p));
			if (!parent || parent.kind !== "dir") throw new FsError("ENOENT", path);
			this.entries.set(p, { kind: "dir", mtimeMs: Date.now() });
		},
		rmdir: async (path: string) => {
			const p = norm(path);
			const e = this.entries.get(p);
			if (!e) throw new FsError("ENOENT", path);
			if (e.kind !== "dir") throw new FsError("ENOTDIR", path);
			if ((await this.promises.readdir(p)).length > 0) throw new FsError("ENOTEMPTY", path);
			this.entries.delete(p);
		},
		stat: async (path: string) => {
			const e = this.entries.get(norm(path));
			if (!e) throw new FsError("ENOENT", path);
			return new Stats(e);
		},
		lstat: async (path: string) => this.promises.stat(path),
		readlink: async (path: string): Promise<string> => {
			throw new FsError("EINVAL", path);
		},
		symlink: async (_target: string, path: string) => {
			throw new FsError("EPERM", path);
		},
		chmod: async () => {},
	};
}
