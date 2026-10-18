---
title: FAQ
metaTitle: "FAQ: shared AI memory for Claude, ChatGPT and coding agents"
description: "Answers to common questions about gitmind: MCP memory, Claude and ChatGPT support, privacy, pricing, self-hosting and how it compares."
section: Reference
order: 13
---

## What is gitmind?

gitmind is an open-source memory for AI agents. It stores what Claude,
ChatGPT, Claude Code and Codex learn as Markdown notes in a git repository you
own, and serves the same notes to every app over MCP (Model Context Protocol).
See the [Introduction](/docs/introduction/).

## What is an MCP memory server?

MCP is the open protocol AI apps use to call outside tools. A memory server
gives the agent tools to search, read and save notes, so it remembers things
between conversations. gitmind provides [these tools](/docs/tools/).

## Which apps does gitmind work with?

claude.ai on the web, Claude Desktop and Claude mobile, ChatGPT, Claude Code
and Codex, plus any other app that supports remote MCP servers with OAuth. See
[Connect your AI apps](/docs/connect/).

## How do I give Claude Code persistent memory?

Add the endpoint with
`claude mcp add --transport http --scope user gitmind https://gitmind.app/mcp`,
or install the CLI and run `gitmind setup` for a synced local clone plus hooks
that load your project's notes at the start of each session. See
[CLI and local sync](/docs/cli/).

## Can Claude and ChatGPT share the same memory?

Yes. Connect both to `https://gitmind.app/mcp` with the same account, and they
read and write the same notes.

## Is gitmind free?

Yes. gitmind.app is free with a GitHub sign-in, and the code is open source
(AGPL-3.0), so you can also [run your own](/docs/self-hosting/).

## Does gitmind work with my Claude Max or ChatGPT subscription?

Yes. gitmind is a connector, not a proxy: your app keeps talking to Claude or
ChatGPT with your normal login and calls gitmind only to read and write notes.

## Do I need GitHub?

You sign in with GitHub. Your notes live on gitmind.app (or your own
deployment); a GitHub repository is only used if you choose CLI sync with
`gitmind setup` instead of the cloud.

## Can I edit notes myself?

Yes: on gitmind.app, in any editor on a CLI clone, or in Obsidian. Your edits
sync like the agents' do.

## How is this different from built-in AI memory?

Built-in memory is per app and managed by its provider. gitmind is shared
across every app and machine, stored as files you can read, edit, version and
take with you, and shared with your team when you want. See
[How gitmind compares](/docs/compare/), including Basic Memory and Mem0.

## Is my memory private?

Your personal workspace is readable only by you, and gitmind never sees your
conversations: agents send it only what they choose to save or search. See
[Security and privacy](/docs/security/).

## Does it use semantic or vector search?

No. Search is full-text keyword search with ranking (best matches first, then
recent notes), filterable by folder, tag, category and date. Agents usually
search with a few likely words, and notes link to each other for context.

## Does it work offline?

With the CLI, yes: agents search the local clone, and changes sync when you're
back online. The hosted endpoint needs a connection.

## Can I leave and take my memory with me?

Yes. Every workspace is a git repository: clone it, or download it as a zip.
The notes are plain Markdown that opens in Obsidian or any editor.

## What happens if two agents write at the same time?

Both changes land. See [How it works](/docs/how-it-works/).
