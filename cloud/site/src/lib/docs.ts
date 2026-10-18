import { getCollection, type CollectionEntry } from "astro:content";
import { absoluteLinks, SITE } from "./site.mjs";

export const sortedDocs = async () => (await getCollection("docs")).sort((a, b) => a.data.order - b.data.order);

/** A docs page as standalone Markdown: title, summary, source URL and body with absolute links. */
export const docMarkdown = (d: CollectionEntry<"docs">) =>
	`# ${d.data.title}\n\n> ${d.data.description}\n\nSource: ${SITE}/docs/${d.id}/\n\n${absoluteLinks(d.body ?? "").trim()}\n`;
