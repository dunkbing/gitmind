// llms.txt (https://llmstxt.org): a plain index of the docs for AI assistants
// and answer engines.
import { sortedDocs } from "../lib/docs";
import { DEFINITION, REPO, SECTIONS, SITE } from "../lib/site.mjs";

export async function GET() {
	const docs = await sortedDocs();
	let out = `# gitmind

> ${DEFINITION}

Key facts:

- Hosted at ${SITE}, free with a GitHub sign-in. The remote MCP endpoint is ${SITE}/mcp, with OAuth sign-in, and works as a custom connector in claude.ai (web, desktop, mobile) and ChatGPT, and in Claude Code and Codex.
- The \`gitmind\` CLI (macOS, Linux, Windows) is a local MCP server for Claude Code and Codex that keeps a synced git clone of the notes in ~/.gitmind; it can sync with gitmind.app, a private GitHub repository, or a self-hosted server.
- Notes are Markdown with YAML frontmatter, observations like \`- [decision] fact #tag\` and \`[[wiki links]]\`; compatible with Basic Memory and Obsidian. Every change is a git commit.
- gitmind runs no LLM of its own: the agent decides what to save; gitmind stores, indexes (keyword full-text search plus, in gitmind cloud, semantic search with embeddings), searches and syncs.
- Team workspaces, import of Claude and ChatGPT chat exports, and a web app for browsing and editing notes.
- Open source (AGPL-3.0), self-hostable on Cloudflare: ${REPO}

Each docs page is also available as Markdown by replacing the trailing slash with \`.md\` (for example ${SITE}/docs/quickstart.md).

`;
	for (const s of SECTIONS) {
		out += `## ${s}\n\n`;
		for (const d of docs.filter((d) => d.data.section === s)) out += `- [${d.data.title}](${SITE}/docs/${d.id}/): ${d.data.description}\n`;
		out += "\n";
	}
	out += `## Optional\n\n- [Full documentation in one file](${SITE}/llms-full.txt)\n- [Home page](${SITE}/): overview, setup snippets and common questions\n- [Source code](${REPO})\n- [Agent memory instructions](${REPO}/blob/main/AGENT_MEMORY.md): standing instructions to give agents\n`;
	return new Response(out, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
