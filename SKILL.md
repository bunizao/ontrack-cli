---
name: ontrack-cli
description: Read OnTrack and Doubtfire units, tasks, task sheets and tutor chats from the terminal; set task status, submit files and message tutors when asked.
---

# OnTrack CLI

Use `ontrack` to inspect and update OnTrack from a terminal. Start from what the user said, not from ids.

`UNIT` is a project ID, or the unit's code or name exactly as OnTrack shows it; `ontrack courses` is the vocabulary for this site. `TASK` is the task abbreviation shown by `ontrack tasks UNIT`, or a task definition ID. Never assume what a code or abbreviation looks like; if a reference matches several units the CLI lists their project IDs, so pick one rather than guess.

## What the user says, and what to run

| The user says | Run | Then |
| --- | --- | --- |
| which units am I in / how are units named here | `ontrack courses` | `--include-inactive` for past units |
| what's in UNIT / my target grade / overall progress | `ontrack courses show UNIT` |  |
| which tasks / what's due / what needs work | `ontrack tasks UNIT` | `--status <status...>` to narrow |
| what does task X say / the task sheet | `ontrack tasks read UNIT TASK` | `tasks show` for status only |
| download the task sheet / task resources | `ontrack tasks get UNIT TASK [--resources] --dest PATH` | `ontrack courses get UNIT` for the whole unit |
| any tutor feedback / unread messages | `ontrack chats UNIT` |  |
| read the tutor's comments on a task | `ontrack chats read UNIT TASK --yes` | tell the user before running it |
| mark a task ready / working on it / need help (only when asked) | `ontrack tasks set UNIT TASK STATE --dry-run` | then repeat with `--yes` |
| submit files for a task (only when asked) | `ontrack tasks submit UNIT TASK --file F --dry-run` | then repeat with `--yes` |
| message the tutor on a task (only when asked) | `ontrack chats send UNIT TASK --message "..." --dry-run` | then repeat with `--yes` |
| am I signed in / is it working | `ontrack auth status` | `ontrack auth login` to sign in |
| my teaching roles | `ontrack roles` | `--all` includes inactive roles |

## Rules

- Run the narrowest command or tool that answers the request; one call per intent.
- Piped output is JSON and a terminal gets a table. `--fields a,b` keeps only the listed top-level fields.
- `read` prints Markdown and never changes anything upstream.
- Run a mutating command only when the user asked for it. It needs a confirmation or `--yes`; `--dry-run` prints the plan first.
- Never print, log or store tokens, cookies or session files.
- `courses`, `units` and `projects` are interchangeable.
- `chats read` is the exception to the `read` rule: it marks the comments read upstream and always requires `--yes`.
- Sign in with `ontrack auth login`; `ontrack auth status` checks the saved session and `ontrack auth logout` removes it.
- Every command, argument and option is in [references/commands.md](references/commands.md); `ontrack commands --json` is the source of truth.

## Setup

```bash
npm install -g ontrack
export ONTRACK_BASE_URL="https://ontrack.example.edu"  # your institution's OnTrack site
ontrack auth login
```

## Errors

Errors are printed once on stderr. Exit codes: 0 success, 2 usage, 3 auth, 1 config, 4 not_found, 5 upstream, 1 network, 130 cancelled, 1 unexpected.
