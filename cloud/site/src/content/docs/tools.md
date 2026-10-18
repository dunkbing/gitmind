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
| `search_notes` | Full-text search (best matches first, notes with every word first, recent notes slightly favoured), filterable by `directory`, `tags`, `category`, `since` (`7d`, `2w`, `2026-10-01`) and `before`. With a category filter, the matching lines are shown. |
| `read_note` | A note in full, with the notes linking to it. |
| `build_context` | A note plus the notes it links to and from, with a one-line summary of each, and links to notes not written yet. `depth: 2` goes one step further. |
| `project_context` | Pinned notes in full, plus an index of a project's notes, general notes and recent activity. For the start of a session. |
| `write_note` | Create a note. Fails if one with the same title exists in that directory, unless `overwrite: true`. The reply lists possibly overlapping notes, to merge instead of duplicating. |
| `edit_note` | `append`, `prepend`, `find_replace`, or `replace_section` (everything under a heading). |
| `move_note` | New directory and/or title; links to the note are updated. |
| `pin_note` | Show a note in full at every session start, or unpin it. |
| `delete_note` | Delete a note; history keeps it. |
| `recent_activity` | Recently changed notes. |
| `list_notes` | List notes, optionally under a directory. |
| `list_workspaces` | Your workspaces (cloud only). |
| `sync_memory` | Pull and push now (CLI only). |

Notes can be identified by path (`ops/runbook.md`), permalink (`ops/runbook`)
or exact title.
