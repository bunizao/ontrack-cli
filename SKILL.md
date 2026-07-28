---
name: ontrack-cli
description: Inspect and update Doubtfire or OnTrack from the terminal with the `ontrack` CLI. Use for projects, tasks, task sheets, submissions, chats, resource downloads, teaching roles, authentication checks, or browser-backed login.
---

# OnTrack CLI

Use `ontrack` for OnTrack inspection and requested file downloads.

## Workflow

1. Run `ontrack auth check --json` before a protected query when authentication state is unknown.
2. If authentication fails, run `ontrack auth login --json`. Let the command search supported browser profiles or open the SAML sign-in URL in the default browser.
3. Use a unit code such as `FIT1045` when it identifies one project. Use `ontrack projects --include-inactive --json` and the returned `id` when a code matches more than one project. Never use a list position as an ID.
4. Run the narrowest command that answers the request. Prefer `--json` for automation.
5. Run `ontrack chats <project>` before opening a task chat when unread state matters. Opening one task's history marks returned non-discussion comments as read.
6. Use `ontrack task read` when an agent needs the contents of a task sheet. Download the PDF only when the user requests a local artifact.
7. Use `--output` when the user names a destination; never remove an existing file without approval.
8. Return the requested facts instead of pasting the full response unless the user asks for raw JSON.

## Commands

```bash
ontrack user --json
ontrack auth check --json
ontrack auth login --json
ontrack projects --json
ontrack projects --include-inactive --json
ontrack project <project> --json
ontrack tasks <project> --json
ontrack tasks <project> --status <status> --json
ontrack chats <project> --json
ontrack chats <project> <task> --json
ontrack chats send <project> <task> --message <text>
ontrack task sheet <project> <task> --output <sheet.pdf> --json
ontrack task resources <project> <task> --output <file> --json
ontrack task read <project> <task>
ontrack task state <project> <task> working_on_it --json
ontrack task submit <project> <task> --file <path> [--file <path> ...]
ontrack resources download <project> --output <archive.zip> --json
ontrack roles --json
ontrack roles --all --json
```

Repeat `--status` to match more than one raw task status.
Use `ontrack project <project> --json` to discover downloadable task definitions when `ontrack tasks` is empty.

## Authentication

- Treat access tokens, refresh cookies, and browser cookies as secrets.
- Never print or copy values from `~/.config/ontrack-cli/session.json` or browser storage.
- Use `ONTRACK_USERNAME` and `ONTRACK_AUTH_TOKEN` only when the user supplies an explicit credential pair.
- Expect `auth login` to cache a short-lived access token with `0600` permissions. The CLI exchanges browser refresh cookies in memory and does not copy them into its cache.
- Browser discovery is the default. Compatible storage-state files under `~/.okta-auth/sessions` are an optional fallback; `okta-auth` is not required.
- After terminal confirmation, the CLI opens the SAML sign-in URL returned by the API.

## Remote mutations

- Never run `ontrack chats send` unless the user explicitly confirms the exact project, task, and message in the current conversation.
- Never infer permission to send from a request to inspect, summarize, draft, or read chats.
- Never run `ontrack task submit` or pass `--yes` unless the user has explicitly confirmed the exact project, task, file list, and submission type.
- Preparing, reading, validating, or downloading files does not grant permission to submit them.
- Use the interactive typed confirmation when possible. `--yes` records an existing confirmation; the flag does not grant permission.

## Output

- Ordinary CLI use prints tables by default; agents should prefer `--json` for reliable parsing.
- `task read` is a content command: it prints Markdown directly so an agent can read or pipe it without parsing a table.
- Keep `--json` output on stdout and diagnostics on stderr.
- Preserve raw status values when reporting tasks. The API may add statuses that the CLI does not yet label.
- Task chat history has an upstream read-state side effect. `chats send` creates a remote comment after confirmation. `task submit` uploads files after a separate confirmation and reports that OnTrack will process them asynchronously. Downloads create local files atomically and refuse to replace existing files.
