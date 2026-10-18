// Every docs page's Markdown in one file, for AI assistants.
import { docMarkdown, sortedDocs } from "../lib/docs";
import { DEFINITION } from "../lib/site.mjs";

export async function GET() {
	const docs = await sortedDocs();
	const out = `# gitmind documentation\n\n> ${DEFINITION}\n\n---\n\n${docs.map(docMarkdown).join("\n---\n\n")}`;
	return new Response(out, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
