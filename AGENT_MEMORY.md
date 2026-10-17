## Long-term memory (memory-go MCP)

You have a persistent, shared memory via the `memory-go` MCP server. It is shared
across my machines and agents (Claude Code, Codex), so treat it as the source of truth
for context that outlives a single session.

**At the start of a task**
- Run `search_notes` with the project name and the key topic of the task. If something
  relevant turns up, open it with `read_note` before planning.
- When I say "continue", "pick up where we left off" or similar, check `recent_activity`
  first.

**While working**
- Don't save routine chatter, code that is already in the repo, or anything git history
  already records. Never save secrets, API keys, tokens or passwords.

**At the end of a task, save what a future session would otherwise have to rediscover:**
- decisions and their reasons ("chose X over Y because…")
- my preferences and corrections to how you work
- gotchas, root causes of non-obvious bugs, environment quirks
- project setup and deploy/ops knowledge not written down in the repo

**How to write notes**
- Update an existing note with `edit_note` rather than creating a near-duplicate; search
  first.
- One topic per note. Use a clear title and put it in a directory named after the
  project (e.g. `myapp/`); use `general/` for cross-project preferences.
- Write observations as `- [category] fact #tag` (categories such as decision,
  preference, gotcha, setup) and link related notes with `[[Note Title]]`.
- Briefly tell me what you saved or updated.
