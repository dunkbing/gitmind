---
title: Review what agents save
metaTitle: "Review AI memory: an inbox for what Claude and ChatGPT save"
description: "Every change an AI app makes to your memory lands in an inbox, with which app made it. Accept it, or reject it to undo it."
section: Guides
order: 7.5
---

AI apps decide on their own what to remember. Most of it is useful; some of it
is noise, a guess, or plain wrong. gitmind keeps a record of every change an
app makes and puts it in your **Inbox** to review.

## How it works

When Claude, ChatGPT or a coding agent saves or edits a note, the change takes
effect right away: other sessions and devices need it at once. It also lands
in the Inbox at [gitmind.app](https://gitmind.app), with:

- **which app made it**: the name of the connected app (claude.ai, ChatGPT…),
  or, for changes pushed from a laptop by the [CLI](/docs/cli/), the agent and
  machine, such as "claude-code on macbook";
- **what changed**: a diff of the note, or the whole note if it's new.

Several edits to the same note make one review, from how the note was before
the first edit to how it is after the last.

For each change you can:

- **Accept** it, which keeps it as it is and clears it from the Inbox.
- **Reject** it, which undoes it: an edit is rolled back, a new note is
  removed, a deleted note comes back. Optionally say why, such as "one-off
  debugging steps". The reason is added to a pinned **Memory feedback** note,
  which agents see at the start of every session, so they stop saving that
  kind of thing.
- **Edit the note** yourself. Your own edit counts as reviewing it.

Your own changes in the web app never go to the Inbox.

## Provenance in git

Every commit says where a change came from: `memory: edit dev/stack.md (cloud,
you, claude.ai)` for a cloud change, `memory: add ops/deploy.md (macbook,
claude-code)` for one pushed by the CLI. The **History** page and `git log`
show it for every change, reviewed or not.

## Settings

In a workspace's **Settings**:

- **Review** can be turned off, so agents' changes no longer go to the Inbox.
- **Trusted apps** skip the Inbox. Trusting an app also clears its pending
  changes.
