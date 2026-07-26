---
name: ontrack-cli
description: Inspect Doubtfire or OnTrack from the terminal with the `ontrack` CLI. Use for authenticated user details, projects, project snapshots, tasks, task status filters, teaching roles, authentication checks, or browser-backed OnTrack login.
---

# OnTrack CLI

Use `ontrack` for read-only OnTrack inspection.

## Workflow

1. Run `ontrack auth check --json` before a protected query when authentication state is unknown.
2. If authentication fails, run `ontrack auth login --json`. Let the command reuse browser cookies or a stored SAML session before starting an interactive login.
3. Resolve an unfamiliar project with `ontrack projects --json` before requesting project or task detail.
4. Run the narrowest command that answers the request. Prefer `--json` for automation.
5. Return the requested facts instead of pasting the full response unless the user asks for raw JSON.

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
ontrack roles --json
ontrack roles --all --json
```

Repeat `--status` to match more than one raw task status.

## Authentication

- Treat access tokens, refresh cookies, browser cookies, and saved `okta-auth` sessions as secrets.
- Never print or copy values from `~/.config/ontrack-cli/session.json` or `~/.okta-auth`.
- Use `ONTRACK_USERNAME` and `ONTRACK_AUTH_TOKEN` only when the user supplies an explicit credential pair.
- Expect `auth login` to cache a short-lived access token with `0600` permissions. The CLI exchanges browser refresh cookies in memory and does not copy them into its cache.
- Do not automate clicks on the OnTrack landing page. The CLI follows the SAML sign-in URL returned by the API.

## Output

- Use terminal tables only when the user requests terminal presentation.
- Keep `--json` output on stdout and diagnostics on stderr.
- Preserve raw status values when reporting tasks. The API may add statuses that the CLI does not yet label.
- Treat every command as read-only. This CLI does not submit work or modify OnTrack records.
