// Every docs page's Markdown in one file, for AI assistants.
import { getCollection } from "astro:content";

export async function GET() {
	const docs = (await getCollection("docs")).sort((a, b) => a.data.order - b.data.order);
	const out = docs.map((d) => `# ${d.data.title}\n\nSource: https://gitmind.app/docs/${d.id}/\n\n> ${d.data.description}\n\n${d.body ?? ""}`).join("\n\n---\n\n");
	return new Response(out, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
