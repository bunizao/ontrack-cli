---
name: ontrack-cli
description: Terminal-first CLI for OnTrack and Doubtfire
---

# OnTrack CLI

Use `ontrack` to inspect and update OnTrack from a terminal. Prefer `--json` for automation.

## Contract

- `units`, `courses`, and `projects` are interchangeable.
- Piped output defaults to JSON; terminal output defaults to a table.
- Mutating commands require an interactive y/N confirmation or `--yes`.
- Use `--dry-run` before a mutation when the intended target is uncertain.
- Never print or copy session tokens, browser cookies, or authentication files.

## Commands

- `ontrack user` — Show the signed-in user
- `ontrack auth` — Manage authentication
- `ontrack auth login` — Sign in through OnTrack
- `ontrack auth status` — Validate current credentials
- `ontrack auth logout` — Remove the cached session
- `ontrack units` (aliases: courses, projects) — OnTrack enrolments
- `ontrack units list` — List units
- `ontrack units show <unit>` — Show one unit
- `ontrack units get <unit>` — Download unit resources
- `ontrack tasks` — OnTrack tasks
- `ontrack tasks list <unit>` — List tasks
- `ontrack tasks show <unit> <task>` — Show one task
- `ontrack tasks read <unit> <task>` — Print a task sheet as Markdown
- `ontrack tasks get <unit> <task>` — Download a task sheet or resources
- `ontrack tasks set <unit> <task> <state>` — Change task workflow state [mutating; requires confirmation or --yes]
- `ontrack tasks submit <unit> <task>` — Submit task files [mutating; requires confirmation or --yes]
- `ontrack chats` — Task chats
- `ontrack chats list <unit>` — List unread chat counts
- `ontrack chats read <unit> <task>` — Read task chat history
- `ontrack chats mark-read <unit> <task>` — Mark task chat comments read [mutating; requires confirmation or --yes]
- `ontrack chats send <unit> <task>` — Send a task chat message [mutating; requires confirmation or --yes]
- `ontrack roles` — Teaching roles
- `ontrack roles list` — List teaching roles
- `ontrack commands` — Describe the complete command tree
- `ontrack skills` — Generate agent integration artifacts
- `ontrack skills generate` — Generate SKILL.md from the command tree

Run `ontrack commands --json` for options, enum values, aliases, and mutation metadata.
