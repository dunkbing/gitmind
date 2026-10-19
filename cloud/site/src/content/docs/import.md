---
title: Import your history
description: "Bring in Claude and ChatGPT conversations, or a folder of Markdown notes."
section: Guides
order: 7
---

In your workspace's **Settings**, under **Import**, upload one of:

- **A Claude export**: claude.ai → Settings → Privacy → Export data. Upload
  the zip you receive by email.
- **A ChatGPT export**: Settings → Data controls → Export data. Upload the zip.
- **A zip of Markdown notes**, from Obsidian, Basic Memory or another gitmind.
  Folder structure is kept.

Each conversation becomes one searchable note under `imports/claude/` or
`imports/chatgpt/`, tagged `import`. Everything lands in a single commit, and
existing notes are never overwritten.

Imported conversations are raw material. Ask an agent to read the ones that
matter and save the lasting facts as regular notes.

## Claude Code's memories

Claude Code keeps its own memories on each machine. The CLI imports them, one
note each: run `gitmind import claude-code` (or accept the offer during
`gitmind setup`). See [the CLI guide](/docs/cli/#import-claude-codes-memories).
