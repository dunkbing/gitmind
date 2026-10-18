---
title: Introduction
description: "What gitmind is, and why your agents' memory belongs in a git repository you own."
section: Getting started
order: 1
---

AI agents forget everything between sessions. You explain the same project
background, the same preferences and the same "don't touch that, the mobile
app still uses it" again and again, in every app.

gitmind is one memory shared by all of them. Agents save what's worth keeping
as short Markdown notes, and every AI app you use reads from the same notes:

- **claude.ai** on the web, Claude Desktop and Claude mobile, and **ChatGPT**,
  through a connector to `https://gitmind.app/mcp`.
- **Claude Code** and **Codex**, through the same endpoint, or locally through
  the [`gitmind` CLI](/docs/cli/), which keeps a synced clone on your laptop.

## What makes it different

- **Your memory is a git repository.** Every note is a Markdown file and
  every change, from any app or machine, is a commit. You can clone it, read
  it in Obsidian, review its history and leave with it.
- **Notes are structured, not transcripts.** Agents write short, standalone
  facts like `- [decision] use Postgres over MySQL #db`, link related notes
  with `[[wiki links]]`, and keep a history when facts change. See
  [Writing notes](/docs/notes/).
- **It runs no LLM of its own.** The agent you're already using decides what
  to save; gitmind stores, indexes, searches and syncs. No extra API keys, no
  proxy between you and your AI provider.
- **Open source.** AGPL-3.0, and [self-hostable](/docs/self-hosting/) on Cloudflare.

Next: [Quickstart](/docs/quickstart/). Curious how this differs from built-in
memory, Basic Memory or Mem0? See [How gitmind compares](/docs/compare/).
