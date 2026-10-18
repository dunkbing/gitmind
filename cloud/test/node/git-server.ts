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
	const polls = new Map<string, number>();
	const server: Server = createServer((req, res) => {
		const url = new URL(req.url!, "http://localhost");
		// A fake GitHub for the device-flow sign-in (GITHUB_WEB_URL /
		// GITHUB_API_URL in tests): the first poll is pending, then approved.
		if (url.pathname.startsWith("/__github/")) {
			res.setHeader("Content-Type", "application/json");
			const path = url.pathname.slice("/__github".length);
			if (req.method === "POST" && path === "/login/device/code") {
				const device = `dev-${polls.size + 1}`;
				polls.set(device, 0);
				return res.end(JSON.stringify({ device_code: device, user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 900 }));
			}
			if (req.method === "POST" && path === "/login/oauth/access_token") {
				let body = "";
				req.on("data", (c) => (body += c));
				req.on("end", () => {
					const device = JSON.parse(body).device_code;
					const n = (polls.get(device) ?? 0) + 1;
					polls.set(device, n);
					res.end(JSON.stringify(n === 1 ? { error: "authorization_pending" } : { access_token: `gh-token-${device}` }));
				});
				return;
			}
			if (req.method === "GET" && path === "/user" && /^Bearer gh-token-/.test(req.headers.authorization ?? "")) {
				return res.end(JSON.stringify({ id: 4242, login: "octo-gh", name: "Octo", avatar_url: null }));
			}
			res.statusCode = 404;
			return res.end("{}");
		}
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
