---
name: ontrack-cli
description: 'Reads OnTrack and Doubtfire units, tasks, task sheets and tutor chats from the terminal; sets task status, submits files and messages tutors when asked. Use when the user names OnTrack or Doubtfire, or asks about portfolio tasks, task sheets, task status, a target grade or tutor feedback on a task: "which tasks are overdue", "what does 3.1P ask for", "did my tutor reply", "mark 2.1P ready for feedback", "submit my pass task". Moodle assignments, quizzes and the gradebook belong to moodle-cli; Ed forum threads and lessons belong to edstem-cli.'
---

# OnTrack CLI

Use `ontrack` to inspect and update OnTrack from a terminal. Start from what the user said, not from ids.

`UNIT` is a project ID, or the unit's code or name exactly as OnTrack shows it; `ontrack courses` is the vocabulary for this site. `TASK` is the task abbreviation shown by `ontrack tasks UNIT`, or a task definition ID. Never assume what a code or abbreviation looks like; if a reference matches several units the CLI lists their project IDs, so pick one rather than guess.

## What the user says, and what to run

| The user says | CLI | Then |
| --- | --- | --- |
| which units am I in / how are units named here | `ontrack courses` | `--include-inactive` for past units |
| what's in UNIT / my target grade / overall progress | `ontrack courses show UNIT` |  |
| which tasks / what's due / what needs work | `ontrack tasks UNIT` | `--status <status...>` to narrow |
| what does task X say / the task sheet | `ontrack tasks read UNIT TASK` | `tasks show` for status only |
| download the task sheet / task resources | `ontrack tasks get UNIT TASK [--resources] --dest PATH` | `ontrack courses get UNIT` for the whole unit |
| any tutor feedback / unread messages | `ontrack chats UNIT` |  |
| read the tutor's comments on a task | `ontrack chats read UNIT TASK --yes` | tell the user before running it |
| mark a task ready / working on it / need help | `ontrack tasks set UNIT TASK STATE` |  |
| submit files for a task | `ontrack tasks submit UNIT TASK --file F` |  |
| message the tutor on a task | `ontrack chats send UNIT TASK --message "..."` |  |
| am I signed in / is it working | `ontrack auth status` | `ontrack auth login` to sign in |
| my teaching roles | `ontrack roles` | `--all` includes inactive roles |

## Workflows

Copy the checklist into your reply and tick each step as it is done; the last step is what shows the change landed.

### Change something upstream

```text
- [ ] Check the user asked for this change, on these targets
- [ ] Run the command with `--dry-run` and show the plan
- [ ] Get the user's yes to that plan
- [ ] Run it again with `--yes`
- [ ] Read the result back with the matching `list` or `show` and report what changed
```

## Rules

- Start from the table row that matches the request: the narrowest command or tool answers sooner and costs fewer tokens than a broad listing.
- Piped output is JSON. `--fields a,b` keeps only those top-level fields, which keeps long lists cheap.
- `read` prints Markdown and changes nothing upstream, so it is safe to run unasked.
- Change something upstream only when the user asked for that change: other people see it, and most changes cannot be undone.
- Keep tokens, cookies and session files out of replies, logs and files; each one is a live sign-in.
- A failure prints one error with a `hint` on stderr; follow the hint before retrying.
- `courses`, `units` and `projects` are interchangeable.
- `chats read` is the exception to the `read` rule: it marks the comments read upstream, so `ontrack chats` stops flagging them; it needs `--yes`.
- Sign in with `ontrack auth login`; `ontrack auth status` checks the saved session and `ontrack auth logout` removes it.
- Every command, argument, option and exit code is in [references/commands.md](references/commands.md); `ontrack commands --json` is the source of truth.

## Setup

```bash
npm install -g ontrack
export ONTRACK_BASE_URL="https://ontrack.example.edu"  # your institution's OnTrack site
ontrack auth login
```
