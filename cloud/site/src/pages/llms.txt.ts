// llms.txt (https://llmstxt.org): a plain index of the docs for AI assistants
// and answer engines.
import { getCollection } from "astro:content";

export async function GET() {
	const docs = (await getCollection("docs")).sort((a, b) => a.data.order - b.data.order);
	const sections = ["Getting started", "Guides", "Reference"];
	let out = "# gitmind\n\n> One shared memory for Claude, ChatGPT, Claude Code and Codex: Markdown notes in a git repository you own, served to every AI app over MCP at https://gitmind.app/mcp. Open source (AGPL-3.0).\n\n";
	for (const s of sections) {
		out += `## ${s}\n\n`;
		for (const d of docs.filter((d) => d.data.section === s)) out += `- [${d.data.title}](https://gitmind.app/docs/${d.id}/): ${d.data.description}\n`;
		out += "\n";
	}
	out += "## Optional\n\n- [Full documentation in one file](https://gitmind.app/llms-full.txt)\n- [Source code](https://github.com/dunkbing/gitmind)\n";
	return new Response(out, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
