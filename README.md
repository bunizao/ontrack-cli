# ontrack-cli

[![CI](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun 1.3.14+](https://img.shields.io/badge/Bun-1.3.14%2B-000000?logo=bun&logoColor=white)](https://bun.sh/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A read-only command-line client for [Doubtfire / OnTrack](https://github.com/doubtfire-lms/doubtfire-api).

Use it to inspect projects, tasks, grades, and teaching roles from a terminal or script. The CLI reuses your OnTrack browser session and does not require a separate authentication package.

## Features

- Read projects, task schedules, grades, and teaching roles.
- Sign in through your existing browser session.
- Return stable JSON for scripts or readable tables for terminals.
- Run the same package with Node.js or Bun.
- Refresh an expired access token from the browser without storing refresh cookies.

## Install

Requires Node.js 22 or newer, or Bun 1.3.14 or newer.

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
2. asks you to press Enter;
3. opens the returned URL in your default browser;
4. waits for the browser to complete sign-in; and
5. exchanges the new OnTrack cookies for a short-lived access token.

You do not need to install or configure `okta-auth`, and you do not need to click **Sign in** on the OnTrack landing page. Normal data commands never open a browser; they ask you to run `ontrack auth login` when authentication is required.

Cookie discovery is provided by [`@steipete/sweet-cookie`](https://github.com/steipete/sweet-cookie). It reads every local profile for Chrome, Edge, and Firefox on macOS, Windows, and Linux, plus Safari and Brave on macOS. It uses the operating system credential store and does not require a global `sqlite3` command.

Browser security rules still apply. On macOS, the terminal running `ontrack` may need Files and Folders or Full Disk Access, and Chromium may request Keychain access. Recent Chrome and Edge releases on Windows may protect cookies with App-Bound Encryption; when those cookies cannot be read, the CLI prints a warning and can still use another supported browser profile.

## Commands

| Command | Description |
| --- | --- |
| `ontrack user` | Show the authenticated user. |
| `ontrack auth login` | Sign in through OnTrack and cache an access token. |
| `ontrack auth check` | Check authentication and show project and role counts. |
| `ontrack projects` | List current projects. |
| `ontrack project <id>` | Show a project and its task snapshot. |
| `ontrack tasks <id>` | List tasks for a project. |
| `ontrack roles` | List teaching and administrative roles. |

Every command supports `--json`:

```bash
ontrack projects --include-inactive --json
ontrack tasks 12345 --status rediscuss --json
ontrack roles --all --json
```

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
