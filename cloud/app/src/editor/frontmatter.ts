// A Markdown extension for the YAML frontmatter at the top of a note, so
// "title: …" followed by "---" isn't read as a heading in source mode.

import { tags as t } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";

export const frontmatter: MarkdownConfig = {
	defineNodes: [{ name: "Frontmatter", block: true, style: t.meta }],
	parseBlock: [
		{
			name: "Frontmatter",
			before: "HorizontalRule",
			parse(cx, line) {
				if (cx.lineStart !== 0 || line.text.trimEnd() !== "---") return false;
				while (cx.nextLine()) {
					if (line.text.trimEnd() === "---") {
						cx.nextLine();
						break;
					}
				}
				cx.addElement(cx.elt("Frontmatter", 0, cx.prevLineEnd()));
				return true;
			},
		},
	],
};
