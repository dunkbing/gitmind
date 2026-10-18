// Where workspace repositories live: Cloudflare Artifacts in production, or a
// plain git HTTP server for local development and tests.

import type { Remote } from "./git";

export interface RepoProvider {
	// create makes the repository if it doesn't exist yet.
	create(name: string): Promise<void>;
	// credentials returns the git remote and a token for it.
	credentials(name: string, scope: "read" | "write", ttlSeconds: number): Promise<{ url: string; token: string; expiresAt: number }>;
}

export function repoProvider(env: Env): RepoProvider {
	return env.DEV_GIT_BASE ? new DevGitProvider(env.DEV_GIT_BASE) : new ArtifactsProvider(env.ARTIFACTS);
}

// remoteFor gives a git layer Remote that reuses a write token until shortly
// before it expires.
export function remoteFor(provider: RepoProvider, name: string): Promise<Remote> {
	let cached: { url: string; token: string; expiresAt: number } | null = null;
	const fresh = async () => {
		if (!cached || cached.expiresAt - Date.now() < 5 * 60_000) cached = await provider.credentials(name, "write", 3600);
		return cached;
	};
	return fresh().then((c) => ({ url: c.url, auth: async () => ({ username: "x", password: (await fresh()).token }) }));
}

class ArtifactsProvider implements RepoProvider {
	constructor(private artifacts: Artifacts) {}

	async create(name: string) {
		try {
			await this.artifacts.create(name, { setDefaultBranch: "main", description: "gitmind workspace" });
		} catch (e) {
			if (!/exist/i.test(String((e as Error)?.message ?? e))) throw e;
		}
	}

	async credentials(name: string, scope: "read" | "write", ttlSeconds: number) {
		using repo = await this.artifacts.get(name);
		const info = await repo.info();
		const token = await repo.createToken(scope, ttlSeconds);
		// Tokens carry their expiry as "?expires=…"; git wants only the secret.
		return { url: info.remote, token: token.plaintext.split("?expires=")[0], expiresAt: Date.parse(String(token.expiresAt)) || Date.now() + ttlSeconds * 1000 };
	}
}

class DevGitProvider implements RepoProvider {
	constructor(private base: string) {}

	async create(name: string) {
		const res = await fetch(`${this.base}/__create?name=${encodeURIComponent(name)}`, { method: "POST" });
		if (!res.ok) throw new Error(`dev git server: ${res.status} ${await res.text()}`);
	}

	async credentials(name: string, _scope: "read" | "write", ttlSeconds: number) {
		return { url: `${this.base}/${name}.git`, token: "dev", expiresAt: Date.now() + ttlSeconds * 1000 };
	}
}
