---
title: Workspaces and teams
description: "Personal and team workspaces, invites and roles."
section: Guides
order: 6
---

Every account has a **personal workspace**. **Team workspaces** share one
memory between several people and all of their agents.

## Create a team

On any workspace's **Settings** page, enter a team name and click **Create
team**. You become its owner.

## Invite people

Owners and admins create **invite links** on the team's Settings page, as
member or admin. Each link works once and expires after 7 days. The person
signs in with GitHub and joins.

## Roles

| Role | Can |
| --- | --- |
| owner | everything, can't be removed |
| admin | read and write notes, invite and remove members |
| member | read and write notes, leave the team |

## Using a team from an agent

Agents pass the team's slug as `workspace` to any tool. With the CLI, run
`gitmind setup --cloud https://gitmind.app --workspace SLUG`.
