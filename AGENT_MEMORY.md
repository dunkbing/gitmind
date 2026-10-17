## Long-term memory (memory-go MCP)

You have a persistent, shared memory via the `memory-go` MCP server. It is shared
across my machines and agents (Claude Code, Codex), so treat it as the source of truth
for context that outlives a single session.

**At the start of a session**
- If a "Memory (memory-go)" section isn't already in your context, call `project_context`
  with the project name (the git repository's directory name).

**At the start of a task**
- Run `search_notes` with the key topic of the task. If something relevant turns up,
  open it with `build_context` to see the related notes too, before planning.
- To review past decisions or known pitfalls, filter instead of guessing keywords:
  `search_notes` with `category: "decision"` (or `gotcha`), `directory`, `tags` or `since: "30d"`.
- When I say "continue", "pick up where we left off" or similar, check `recent_activity`
  first.

**While working**
- Don't save routine chatter, code that is already in the repo, or anything git history
  already records. Never save secrets, API keys, tokens or passwords.

**At the end of a task, save what a future session would otherwise have to rediscover:**
- decisions and their reasons ("chose X over Y because…")
- my preferences and corrections to how you work, and standing rules ("from now on…")
- gotchas, root causes of non-obvious bugs, environment quirks, approaches that failed
- project setup and deploy/ops knowledge not written down in the repo

**What not to save** (prefer saving nothing over saving noise)
- Facts that only make sense inside this conversation: every note must stand on its own.
- Suggestions nobody confirmed: a proposal is not a decision until I agree. Your own output
  only counts once I adopt it.
- One-off requests, routine steps, and anything already in the code or git history.

**How to write notes**
- Update an existing note with `edit_note` rather than creating a near-duplicate; search
  first. For notes organized under headings, `replace_section` rewrites one section cleanly.
- Reorganize with `move_note` (it keeps links working), not by deleting and rewriting.
- One topic per note. Use a clear title and put it in a directory named after the
  project's git repository (e.g. `myapp/`); use `general/` for cross-project preferences.
- Write observations as `- [category] fact #tag` and link related notes with `[[Note Title]]`.
  Categories: `decision`, `preference`, `instruction` (standing rules), `gotcha`,
  `anti-pattern`, `setup`, `task` (with its status), `artifact` (with a link to the doc or PR).
- When a fact changes, update it, and keep the old version with its date under a `## History`
  section instead of silently overwriting it.
- When `write_note` reports possibly overlapping notes, merge into the existing one if it's
  the same topic.
- Pin a note (`pin_note`) only when I ask for something to be always remembered. Never change
  notes marked `locked`; suggest the change to me instead.
- Briefly tell me what you saved or updated.
