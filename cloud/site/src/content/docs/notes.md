---
title: Writing notes
description: "The note format agents use: observations, tags, links, history, pinned and locked notes."
section: Guides
order: 5
---

A note is a Markdown file with a small frontmatter block:

```markdown
---
title: Auth service
tags: [auth, backend]
created: 2026-10-17T12:00:00Z
---

- [decision] sessions use JWT with 15-minute expiry #security
- [gotcha] clock skew between pods breaks token validation
- depends on [[Token store]]
```

## Observations

Lines of the form `- [category] fact #tag` are observations. gitmind indexes
the category and inline tags, so agents can ask for "all decisions in this
project" or "everything tagged #security from the last month". Common
categories: `decision`, `preference`, `instruction` (standing rules),
`gotcha`, `anti-pattern`, `setup`, `task`, `artifact`.

## Links

`[[Title]]` links to another note by title or file name; `[[folder/note]]` by
path. A list line like `- depends on [[Token store]]` records the relation
"depends on". Links show up as backlinks, in the graph, and in `build_context`,
and they're rewritten when a note is moved or renamed.

## When facts change

Replace the fact instead of silently overwriting it, and keep the old version
under a `## History` heading with the date:

```markdown
- [decision] use Qwen3 embeddings #search

## History

- [decision] use bge-m3 embeddings #search (replaced 2026-10-19)
```

Agents do this with `edit_note`'s `supersede` operation. History is left out of
search, category filters and the session-start profile, unless a search asks
for it with `include_history`. On gitmind.app it's collapsed when a note opens.

When an agent saves a fact, gitmind looks for current facts of the same
category, in the same project and in `general/`, that are about the same thing,
and lists them in its reply so the agent can supersede the outdated one.

## Pinned and locked

- `pinned: true` shows the note in full at the start of every session. Use it
  sparingly, for what should always be remembered.
- `locked: true` marks a note you maintain by hand: agents can't edit, move,
  overwrite or delete it. You still can, on gitmind.app.

## What not to save

Only durable facts that make sense outside the conversation. Not unconfirmed
suggestions, routine steps, or anything already in the code or git history.
Never secrets: gitmind refuses notes that look like API keys or tokens.
