---
name: ontrack-cli
description: Work with OnTrack tasks and chats from the command line.
---

# OnTrack CLI

Use `ontrack` to inspect and update OnTrack from a terminal. Start from what the user said, not from ids.

## What the user says, and what to run

`UNIT` is a project ID, or the unit's code or name exactly as OnTrack shows it; `ontrack units` is the vocabulary for this site. `TASK` is the task abbreviation shown by `ontrack tasks UNIT`, or a task definition ID. Never assume what a code or abbreviation looks like; if a reference matches several units the CLI lists their project IDs, so pick one rather than guess.

| The user says | Run | Notes |
| --- | --- | --- |
| which units am I in / how are units named here | `ontrack units` | `--include-inactive` for past units |
| what's in UNIT / my target grade / overall progress | `ontrack units show UNIT` |  |
| which tasks / what's due / what needs work | `ontrack tasks UNIT` | `--status <status...>` to narrow |
| what does task X say / the task sheet | `ontrack tasks read UNIT TASK` | Markdown; `tasks show` for status only |
| download the task sheet / task resources | `ontrack tasks get UNIT TASK [--resources] --dest PATH` | `ontrack units get UNIT` for the whole unit |
| any tutor feedback / unread messages | `ontrack chats UNIT` | unread counts per task |
| read the tutor's comments on a task | `ontrack chats read UNIT TASK --yes` | marks them read upstream; tell the user first |
| mark a task ready / working on it / need help (only when asked) | `ontrack tasks set UNIT TASK STATE --dry-run` | then repeat with `--yes` |
| submit files for a task (only when asked) | `ontrack tasks submit UNIT TASK --file F --dry-run` | then repeat with `--yes` |
| message the tutor on a task (only when asked) | `ontrack chats send UNIT TASK --message "..." --dry-run` | then repeat with `--yes` |
| am I signed in / is it working | `ontrack auth status` | `ontrack auth login` to sign in |
| my teaching roles | `ontrack roles` | `--all` includes inactive roles |

## Contract

- `units`, `courses`, and `projects` are interchangeable.
- `ontrack commands --json` is the source of truth for this tool's command tree; the published `@bunizao/cli-kit` npm package (`^0.1.0`) defines the shared CLI contract.
- Piped output defaults to JSON; terminal output defaults to a table.
- Mutating commands require explicit user intent and an interactive y/N confirmation or `--yes`.
- `chats read` is an upstream exception: it marks comments read and always requires `--yes`.
- Use `--dry-run` before a mutation when the intended target is uncertain.
- Never print or copy session tokens, browser cookies, or authentication files.

## Commands

- `ontrack user` — Show the signed-in user
- `ontrack auth` — Manage authentication
- `ontrack auth login` — Sign in through OnTrack
- `ontrack auth status` — Validate current credentials
- `ontrack auth logout` — Remove the cached session
- `ontrack units` (aliases: courses, projects) — Enrolled units
- `ontrack units list` — List units
- `ontrack units show <unit>` — Show one unit
- `ontrack units get <unit>` — Download unit resources
- `ontrack tasks` — Tasks in a unit: list, read, submit, set state
- `ontrack tasks list <unit>` — List tasks
- `ontrack tasks show <unit> <task>` — Show one task
- `ontrack tasks read <unit> <task>` — Print a task sheet as Markdown
- `ontrack tasks get <unit> <task>` — Download a task sheet or resources
- `ontrack tasks set <unit> <task> <state>` — Change task workflow state [mutating; requires confirmation or --yes]
- `ontrack tasks submit <unit> <task>` — Submit task files [mutating; requires confirmation or --yes]
- `ontrack chats` — Read and send task chat messages
- `ontrack chats list <unit>` — List unread chat counts
- `ontrack chats read <unit> <task>` — Read task chat history and mark comments read [mutating; requires --yes]
- `ontrack chats mark-read <unit> <task>` — Mark task chat comments read [mutating; requires confirmation or --yes]
- `ontrack chats send <unit> <task>` — Send a task chat message [mutating; requires confirmation or --yes]
- `ontrack roles` — Teaching roles you hold
- `ontrack roles list` — List teaching roles
- `ontrack commands` — Describe the complete command tree
- `ontrack skills` — Generate the agent skill
- `ontrack skills generate` — Generate SKILL.md from the command tree

Run `ontrack commands --json` for options, enum values, aliases, and mutation metadata.
