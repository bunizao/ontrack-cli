# ontrack-cli

[![CI](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun 1.3.14+](https://img.shields.io/badge/Bun-1.3.14%2B-000000?logo=bun&logoColor=white)](https://bun.sh/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A terminal client for [Doubtfire / OnTrack](https://github.com/doubtfire-lms/doubtfire-api). It provides fast access to projects, tasks, grades, and teaching roles while reusing your existing browser sign-in.

## Features

- Runs the same emitted ESM package on Node.js and Bun.
- Imports OnTrack cookies from Chrome, Brave, Edge, or Firefox when the operating system permits access.
- Reuses stored SAML browser sessions through [`okta-auth`](https://github.com/bunizao/okta-auth) before opening an interactive login.
- Exchanges refresh cookies in memory and stores only the short-lived OnTrack access token with `0600` permissions.
- Refreshes a rejected read request once, then retries it with a new access token.
- Produces stable JSON for scripts and readable tables for terminals.
- Verifies the TypeScript implementation against sanitized output from the final Python release.

## Requirements

- Node.js 22 or newer, or Bun 1.3.14 or newer
- An OnTrack deployment URL
- `okta-auth` for browser-based SAML login, unless you provide explicit credentials

## Install

Install the package after it is published:

```bash
npm install --global @bunizao/ontrack
```

Install the current branch from source:

```bash
git clone https://github.com/bunizao/ontrack-cli.git
cd ontrack-cli
npm ci
npm link
```

The installed command remains `ontrack` under both runtimes.

## Quick start

Set the root URL for your OnTrack deployment:

```bash
export ONTRACK_BASE_URL='https://ontrack.example.edu'
```

Install and configure `okta-auth`, then obtain an OnTrack access token:

```bash
uv tool install okta-auth-cli
okta config
ontrack auth login
ontrack auth check
```

`auth login` tries these sources in order:

1. A matching browser cookie pair from a local profile
2. A stored OnTrack session from `okta-auth`
3. A stored session for the deployment's SAML sign-in URL
4. A visible SAML login

The CLI follows the SAML URL returned by `/api/auth/method`, so you do not need to click the OnTrack landing page's **Sign in** button. Normal data commands do not open an interactive browser.

On macOS, reading Chromium profiles may require Files and Folders permission and Keychain access. Firefox import requires the `sqlite3` command. If direct profile access fails, the CLI continues with the stored SAML session.

## Commands

| Command | Description |
| --- | --- |
| `ontrack user` | Show the authenticated user. |
| `ontrack auth login` | Obtain and cache an OnTrack access token. |
| `ontrack auth check` | Validate authentication and show project and role counts. |
| `ontrack projects` | List current projects. |
| `ontrack project <id>` | Show one project with its task snapshot. |
| `ontrack tasks <id>` | List tasks for one project. |
| `ontrack roles` | List teaching and administrative roles. |

Useful options:

```bash
ontrack projects --include-inactive --json
ontrack tasks 12345 --status rediscuss --json
ontrack roles --all --json
```

Every command supports `--json`. Successful JSON commands write only the result to stdout; failures leave stdout empty. The TypeScript release removes the former `--yaml` output mode.

## Configuration

You can place `config.yaml` in the current directory, `$XDG_CONFIG_HOME/ontrack-cli/config.yaml`, or `~/.config/ontrack-cli/config.yaml`:

```yaml
base_url: https://ontrack.example.edu
```

`ONTRACK_CONFIG` selects a specific file. Configuration lookup follows this order:

1. `ONTRACK_CONFIG`
2. `config.yaml` in the current directory
3. The XDG or platform configuration directory

For automation, provide both values together:

```bash
export ONTRACK_USERNAME='your_username'
export ONTRACK_AUTH_TOKEN='your_access_token'
```

Explicit credentials take precedence over cached and browser-backed sessions. The CLI never writes refresh cookies to its cache or includes credentials in output and diagnostics.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run test:bun
npm run verify:oracle
npm pack --dry-run
```

CI runs the contract suite on Linux, macOS, and Windows with Node.js 22 and 24, plus Bun 1.3.14. The oracle check replays a sanitized live fixture through the pinned Python 0.1.3 implementation and compares representative command output.

Read [ADR 0001](docs/adr/0001-typescript-7-dual-runtime-rewrite.md) for the cutover decisions and [PORTING.md](PORTING.md) for the module map.

## License

[MIT](LICENSE)
