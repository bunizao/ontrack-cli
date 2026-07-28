---
name: ontrack-cli
description: Inspect Doubtfire or OnTrack from the terminal with the `ontrack` CLI. Use for authenticated user details, projects, tasks, chats, resource downloads, teaching roles, authentication checks, or browser-backed OnTrack login.
---

# OnTrack CLI

Use `ontrack` for OnTrack inspection and requested file downloads.

## Workflow

1. Run `ontrack auth check --json` before a protected query when authentication state is unknown.
2. If authentication fails, run `ontrack auth login --json`. Let the command search supported browser profiles or open the SAML sign-in URL in the default browser.
3. Resolve an unfamiliar project with `ontrack projects --include-inactive --json` before requesting project or task detail. Use the returned `id` field, not the project's list position.
4. Run the narrowest command that answers the request. Prefer `--json` for automation.
5. Run `ontrack chats <project-id>` before opening a task chat when unread state matters. Opening one task's history marks returned non-discussion comments as read.
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
ontrack project <project-id> --json
ontrack tasks <project-id> --json
ontrack tasks <project-id> --status <status> --json
ontrack chats <project-id> --json
ontrack chats <project-id> <task> --json
ontrack task sheet <project-id> <task> --output <sheet.pdf> --json
ontrack task resources <project-id> <task> --output <file> --json
ontrack task read <project-id> <task>
ontrack resources download <project-id> --output <archive.zip> --json
ontrack roles --json
ontrack roles --all --json
```

Repeat `--status` to match more than one raw task status.
Use `ontrack project <project-id> --json` to discover downloadable task definitions when `ontrack tasks` is empty.

## Authentication

- Treat access tokens, refresh cookies, and browser cookies as secrets.
- Never print or copy values from `~/.config/ontrack-cli/session.json` or browser storage.
- Use `ONTRACK_USERNAME` and `ONTRACK_AUTH_TOKEN` only when the user supplies an explicit credential pair.
- Expect `auth login` to cache a short-lived access token with `0600` permissions. The CLI exchanges browser refresh cookies in memory and does not copy them into its cache.
- Browser discovery is the default. Compatible storage-state files under `~/.okta-auth/sessions` are an optional fallback; `okta-auth` is not required.
- After terminal confirmation, the CLI opens the SAML sign-in URL returned by the API.

## Output

- Ordinary CLI use prints tables by default; agents should prefer `--json` for reliable parsing.
- `task read` is a content command: it prints Markdown directly so an agent can read or pipe it without parsing a table.
- Keep `--json` output on stdout and diagnostics on stderr.
- Preserve raw status values when reporting tasks. The API may add statuses that the CLI does not yet label.
- Commands do not submit work. Task chat history has an upstream read-state side effect. Downloads create local files atomically and refuse to replace existing files.
