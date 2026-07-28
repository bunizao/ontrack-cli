# ontrack-cli

[![CI](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml)
[![Node.js 22.5+](https://img.shields.io/badge/Node.js-22.5%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun 1.3.14+](https://img.shields.io/badge/Bun-1.3.14%2B-000000?logo=bun&logoColor=white)](https://bun.sh/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A command-line client for [Doubtfire / OnTrack](https://github.com/doubtfire-lms/doubtfire-api).

Inspect projects, tasks, grades, chats, and teaching roles from a terminal or script. Download unit resources or one task's files without installing a separate authentication package.

## Features

- Read projects, task schedules, grades, and teaching roles.
- Download one task sheet, one task's resources, or the unit-wide resource archive.
- Review unread chat counts and task comment history.
- Sign in through your existing browser session.
- Show readable tables by default and stable JSON with `--json`.
- Run the same package with Node.js or Bun.
- Refresh an expired access token from the browser without storing refresh cookies.

## Install

Requires Node.js 22.5 or newer, or Bun 1.3.14 or newer. Releases of Node.js that gate `node:sqlite` behind an experimental flag are handled automatically.

```bash
npm install --global @bunizao/ontrack
```

To install from source:

```bash
git clone https://github.com/bunizao/ontrack-cli.git
cd ontrack-cli
npm ci
npm run build
npm link
```

## Quick start

```bash
export ONTRACK_BASE_URL='https://ontrack.infotech.monash.edu'
ontrack auth login
ontrack projects
```

`auth login` first looks for a valid OnTrack session in your local browser profiles. If none is available, it:

1. requests the sign-in URL from `/api/auth/method`;
2. prints the sign-in URL so you can copy it to any browser;
3. asks you to press Enter to open the same URL in your default browser;
4. waits for the browser to complete sign-in; and
5. exchanges the new OnTrack cookies for a short-lived access token.

You do not need to install or configure `okta-auth`. Normal data commands never open a browser; they ask you to run `ontrack auth login` when authentication is required.

Automatic completion requires **Remember me** to be enabled in OnTrack. The OnTrack API only creates reusable browser cookies when that setting is enabled; otherwise the browser can sign in successfully but the CLI cannot import the session. The command reports its five-minute waiting limit and explains this setting if it times out.

Cookie discovery is provided by [`@steipete/sweet-cookie`](https://github.com/steipete/sweet-cookie). It reads local Chrome, Edge, and Firefox profiles on macOS, Windows, and Linux, plus Safari and Brave on macOS. It uses the operating system credential store and does not require a global `sqlite3` command. The CLI can also reuse compatible Playwright storage-state files in `~/.okta-auth/sessions`; this is optional and does not add an `okta-auth` dependency.

Browser security rules still apply. On macOS, grant Full Disk Access to the application that launches `ontrack`—for example Terminal, iTerm, or ChatGPT—not to the CLI itself. Chromium may also request Keychain access. When access is denied, `auth login` prints the relevant System Settings location without exposing browser paths or Cookie values. Recent Chrome and Edge releases on Windows may protect cookies with App-Bound Encryption; the CLI can still try another supported browser profile.

## Commands

| Command | Description |
| --- | --- |
| `ontrack user` | Show the authenticated user. |
| `ontrack auth login` | Sign in through OnTrack and cache an access token. |
| `ontrack auth check` | Check authentication and show project and role counts. |
| `ontrack projects` | List current projects. |
| `ontrack project <project_id>` | Show a project and its task snapshot. |
| `ontrack tasks <project_id>` | List tasks for a project. |
| `ontrack resources download <project_id>` | Download the project's unit-wide resource ZIP. |
| `ontrack task sheet <project_id> <task>` | Download one task sheet. |
| `ontrack task resources <project_id> <task>` | Download one task's linked file or resource ZIP. |
| `ontrack chats <project_id>` | List tasks and unread comment counts without opening chat streams. |
| `ontrack chats <project_id> <task>` | Show one task's chronological comment history. |
| `ontrack roles` | List teaching and administrative roles. |

Commands print tables by default. Use `--json` for automation:

```bash
ontrack projects --include-inactive --json
ontrack tasks 12345 --status rediscuss --json
ontrack chats 12345 --json
ontrack chats 12345 1.1 --json
ontrack task sheet 12345 1.1 --output FIT1061-1.1.pdf --json
ontrack task resources 12345 1.1 --output 1.1-resources.zip --json
ontrack resources download 5183 --output FIT1061-resources.zip --json
ontrack roles --all --json
```

Use the `id` field from `ontrack projects --include-inactive`; project IDs are not list positions.

The task selector accepts an abbreviation shown by `ontrack project`; a task-definition ID is also accepted. When OnTrack has not generated project task instances, the project table lists the authorized unit definitions that remain available for download. Server filenames are used when possible. Existing files are never replaced, downloads are written atomically, and large ranged responses are assembled before the file is committed.

`resources download` retrieves the complete unit archive exposed by OnTrack. It is not filtered to the student's current task rows. The archive does not include general unit website content.

`chats <project_id>` reads unread counts from the project snapshot and does not open comment streams. Reading one task's history causes OnTrack to mark returned non-discussion comments as read; the CLI prints this side effect to stderr before presenting the result.

Successful JSON commands write only the result to stdout. Diagnostics and interactive prompts go to stderr.

## Configuration

Set the deployment URL with `ONTRACK_BASE_URL`, or add it to `config.yaml`:

```yaml
base_url: https://ontrack.infotech.monash.edu
```

The CLI checks these configuration locations in order:

1. the file selected by `ONTRACK_CONFIG`;
2. `config.yaml` in the current directory; and
3. the platform configuration directory, such as `~/.config/ontrack-cli/config.yaml`.

For non-interactive automation, provide an explicit credential pair:

```bash
export ONTRACK_USERNAME='your_username'
export ONTRACK_AUTH_TOKEN='your_access_token'
```

Explicit credentials take precedence over the local session cache and browser cookies. The cache contains only the username, short-lived access token, expiry, deployment URL, and credential source. Refresh cookies are never copied into it.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run test:bun
npm run verify:oracle
node scripts/package-smoke.mjs
```

CI verifies the contract suite and packed npm artifact on Linux, macOS, and Windows with Node.js 22, Node.js 24, and Bun.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [Architecture](docs/architecture.md) for the module boundaries.

## License

[MIT](LICENSE)
