import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const docs = defineCollection({
	loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
	schema: z.object({
		title: z.string(),
		/** A fuller <title> for search results, when `title` is a short sidebar label. */
		metaTitle: z.string().optional(),
		description: z.string(),
		section: z.enum(["Getting started", "Guides", "Reference"]),
		order: z.number(),
	}),
});

export const collections = { docs };
