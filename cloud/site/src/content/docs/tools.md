---
title: MCP tools
description: "Reference for every tool gitmind exposes to agents."
section: Reference
order: 8
---

The cloud endpoint and the local CLI expose the same tools. Cloud tools also
take an optional `workspace` (a team's slug).

| Tool | What it does |
| --- | --- |
| `search_notes` | Search by meaning and keywords together (`mode`: `hybrid`, the default; `keyword`; or `semantic`; meaning needs gitmind cloud), filterable by `directory`, `tags`, `category`, `since` (`7d`, `2w`, `2026-10-01`) and `before`. With a category filter, the matching lines are shown. Facts under History headings are left out unless `include_history: true`; notes matched only there come last, marked `[history]`. |
| `read_note` | A note in full, with the notes linking to it. |
| `build_context` | A note plus the notes it links to and from, with a one-line summary of each, and links to notes not written yet. `depth: 2` goes one step further. |
| `project_context` | Your profile (standing `[instruction]` and `[preference]` lines from general and project notes), pinned notes in full, plus an index of a project's notes, general notes and recent activity. For the start of a session; `budget` sets its size. |
| `write_note` | Create a note. Fails if one with the same title exists in that directory, unless `overwrite: true`. The reply lists possibly overlapping notes, to merge instead of duplicating, and [possibly conflicting facts](/docs/notes/#when-facts-change). |
| `edit_note` | `append`, `prepend`, `find_replace`, `replace_section` (everything under a heading), or `supersede`: replace a fact (`find_text`) with a new one (`content`, empty to retire it), keeping the old one under `## History` with the date. The reply lists possibly conflicting facts. |
| `move_note` | New directory and/or title; links to the note are updated. |
| `pin_note` | Show a note in full at every session start, or unpin it. |
| `delete_note` | Delete a note; history keeps it. |
| `recent_activity` | Recently changed notes. |
| `list_notes` | List notes, optionally under a directory. |
| `list_workspaces` | Your workspaces (cloud only). |
| `sync_memory` | Pull and push now (CLI only). |

Notes can be identified by path (`ops/runbook.md`), permalink (`ops/runbook`)
or exact title. For the note format these tools read and write, see
[Writing notes](/docs/notes/).
