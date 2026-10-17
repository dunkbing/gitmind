// A git smart-HTTP server for tests: bridges HTTP to `git http-backend`, the
// same protocol Cloudflare Artifacts speaks.
import { spawn, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitServer {
	url(repo: string): string;
	createRepo(repo: string): string; // returns the bare repo path
	close(): Promise<void>;
}

export async function startGitServer(port = 0): Promise<GitServer> {
	const root = mkdtempSync(join(tmpdir(), "git-server-"));
	const create = (repo: string) => {
		const p = join(root, `${repo}.git`);
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", p]);
		return p;
	};
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url!, "http://localhost");
		// Test-only endpoint standing in for Artifacts' create().
		if (req.method === "POST" && url.pathname === "/__create") {
			const name = url.searchParams.get("name") ?? "";
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
				res.statusCode = 400;
				return res.end("bad name");
			}
			try {
				create(name);
			} catch {
				// already exists
			}
			return res.end("ok");
		}
		if (process.env.GIT_SERVER_DEBUG) console.error("REQ", req.method, req.url, JSON.stringify(req.headers));
		const child = spawn("git", ["http-backend"], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: "1",
				REMOTE_USER: "test", // enables receive-pack (push)
				PATH_INFO: decodeURIComponent(url.pathname),
				REQUEST_METHOD: req.method!,
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: req.headers["content-type"] ?? "",
				...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
			},
		});
		req.pipe(child.stdin);
		const chunks: Buffer[] = [];
		child.stdout.on("data", (c) => chunks.push(c));
		child.on("close", (code) => {
			if (process.env.GIT_SERVER_DEBUG) console.error("DONE", req.method, req.url, code);
			const out = Buffer.concat(chunks);
			const split = out.indexOf("\r\n\r\n");
			const head = out.subarray(0, split).toString();
			let status = 200;
			for (const line of head.split("\r\n")) {
				const i = line.indexOf(":");
				const k = line.slice(0, i).trim();
				const v = line.slice(i + 1).trim();
				if (k.toLowerCase() === "status") status = parseInt(v, 10);
				else if (k) res.setHeader(k, v);
			}
			res.statusCode = status;
			res.end(out.subarray(split + 4));
		});
	});
	await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
	const actual = (server.address() as { port: number }).port;
	return {
		url: (repo) => `http://127.0.0.1:${actual}/${repo}.git`,
		createRepo: create,
		close: () => new Promise((r) => server.close(() => r())),
	};
}
