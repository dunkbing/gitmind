---
title: Quickstart
description: "Sign in, connect your first AI app, and save your first memory in a few minutes."
section: Getting started
order: 2
---

## 1. Sign in

Open [gitmind.app](https://gitmind.app/app) and sign in with GitHub. You get a
personal workspace: your private memory.

## 2. Connect an AI app

The fastest way is a connector in claude.ai:

1. Go to **Settings → Connectors → Add custom connector**.
2. Name it `gitmind` and enter `https://gitmind.app/mcp`.
3. Click **Connect**, then **Allow** on gitmind's consent page.

The connector works in Claude on the web, desktop and mobile. For ChatGPT,
Claude Code and Codex, see [Connect your AI apps](/docs/connect/).

## 3. Use it

Ask Claude to remember something:

> Remember that this project deploys from the `release` branch, never `main`.

It saves a note, and you'll see it in your workspace on gitmind.app. In a new
conversation, ask what it knows about deploying, and it finds the note. In a
coding agent, open a project and ask: "What do you remember about this
project?"

## 4. Optional: tell agents how to use memory

Agents use gitmind better with a few standing instructions: search memory at
the start of a task, save durable facts at the end, leave a handoff when work
is unfinished, and never save secrets. The Claude Code and Codex plugins (see
[CLI and local sync](/docs/cli/)) include them. Elsewhere, add the text from
[`AGENT_MEMORY.md`](https://github.com/dunkbing/gitmind/blob/main/AGENT_MEMORY.md)
to your Claude project instructions.
