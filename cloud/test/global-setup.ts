// Starts the git server that stands in for Cloudflare Artifacts in Worker
// tests (DEV_GIT_BASE in vitest.config.ts).
import { startGitServer } from "./node/git-server";

export const GIT_PORT = 18765;

export default async function () {
	const server = await startGitServer(GIT_PORT);
	return () => server.close();
}
