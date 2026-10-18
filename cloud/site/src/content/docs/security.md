---
title: Security and privacy
description: "Who can read your memory, how sign-in works, and what gitmind refuses to store."
section: Reference
order: 11
---

- **Access.** Only you can read your personal workspace. Team workspaces are
  visible to their members. Each app you connect signs in with OAuth and is
  shown on a consent page first.
- **Tokens.** Access tokens expire after an hour; logins last 90 days and lapse
  after 30 days unused. Git access uses short-lived tokens for one workspace's
  repository.
- **Secrets.** gitmind refuses to save notes that look like API keys, tokens,
  passwords or private keys, because git history would keep them.
- **Your data.** Every workspace is a git repository you can clone or download
  as a zip at any time.
- **No AI in the middle.** gitmind doesn't call an LLM or proxy your
  conversations. Agents send it only what they choose to save or search.
- **Open source.** The code that runs gitmind.app is public, so you can check
  all of this.
