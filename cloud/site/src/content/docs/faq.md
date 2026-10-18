---
title: FAQ
description: "Common questions about gitmind."
section: Reference
order: 12
---

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

Built-in memory is per app and opaque. gitmind is shared across every app and
machine, stored as files you can read, edit, version and take with you, and
shared with your team when you want.

## What happens if two agents write at the same time?

Both changes land. See [How it works](/docs/how-it-works/).
