---
title: How it works
description: "Architecture, syncing and conflict handling, for the curious."
section: Reference
order: 9
---

## The cloud

gitmind.app is a single Cloudflare Worker:

- An **OAuth 2.1 authorization server** (dynamic client registration and
  PKCE), which is how claude.ai, ChatGPT and the CLI sign in.
- The **MCP endpoint** at `/mcp`.
- One **Durable Object per workspace**, holding a SQLite full-text index of its
  notes, links, tags and observations. It's the only cloud-side writer of the
  workspace's repository.
- One **git repository per workspace** on Cloudflare Artifacts, which is also
  the remote your laptops push to.

## Writes never get lost

A change is computed from the latest notes, committed and pushed. If a laptop
pushed first, the push is rejected; gitmind fetches the new state and
recomputes the change on top of it. An "append this line" is replayed, not
merged.

On laptops, Markdown files use git's union merge, so two machines appending to
the same note keep both sides. Real conflicts (one machine deletes what another
edits) keep the edited note.

## Freshness

Cloud reads check the repository for pushes from elsewhere at most every 2
seconds, so a note saved on your laptop is visible to claude.ai almost
immediately.

## The format

Notes are plain Markdown with YAML frontmatter, compatible with Basic Memory and
Obsidian. The cloud and the [CLI](/docs/cli/) share one format, byte for byte.
See [Writing notes](/docs/notes/) for the conventions agents follow.
