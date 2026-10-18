// Each docs page as plain Markdown (/docs/quickstart.md), for AI assistants
// (linked from the page as rel="alternate" and listed in llms.txt).
import type { APIRoute, GetStaticPaths } from "astro";
import { docMarkdown, sortedDocs } from "../../lib/docs";

export const getStaticPaths = (async () => (await sortedDocs()).map((entry) => ({ params: { slug: entry.id }, props: { entry } }))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
	new Response(docMarkdown(props.entry), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
