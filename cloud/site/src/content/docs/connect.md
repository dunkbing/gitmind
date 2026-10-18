---
title: Connect your AI apps
metaTitle: "Connect claude.ai, ChatGPT, Claude Code and Codex to gitmind over MCP"
description: "Add gitmind to claude.ai, Claude Desktop and mobile, ChatGPT, Claude Code and Codex."
section: Getting started
order: 3
---

Every app connects to the same MCP endpoint and signs in to your account with
OAuth:

```
https://gitmind.app/mcp
```

## claude.ai, Claude Desktop and mobile

**Settings → Connectors → Add custom connector**, name it `gitmind`, enter the
URL above and click **Connect**. One connector covers every device you use
Claude on.

## ChatGPT

**Settings → Apps & Connectors → Create** (with developer mode enabled), enter
the URL above and choose OAuth.

## Claude Code

```bash
claude mcp add --transport http --scope user gitmind https://gitmind.app/mcp
```

Then run `/mcp` inside Claude Code and sign in. For a local clone with offline
access, session-start recall and a save reminder, use the
[CLI](/docs/cli/) instead.

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.gitmind]
url = "https://gitmind.app/mcp"
```

Then run `codex mcp login gitmind`.

## Which workspace do agents use?

Your personal workspace, unless the agent passes `workspace` with a team's
slug. Agents can call `list_workspaces` to see yours.
