# ontrack-cli

Terminal-first CLI for Doubtfire / OnTrack, published as emitted ESM JavaScript for Node and Bun.

## Requirements

- Node.js 22 or newer, or Bun 1.3.14 or newer
- An existing session managed by [`okta-auth`](https://github.com/bunizao/okta-auth), or explicit OnTrack credentials

## Install

```bash
npm install --global @bunizao/ontrack
```

The package keeps the executable name `ontrack`. Bun runs the same emitted artifact:

```bash
bun run --bun ontrack --help
```

## Commands

```bash
ontrack user
ontrack auth check
ontrack projects
ontrack project 12345
ontrack tasks 12345
ontrack roles
```

Retained options:

- `--json` on every command
- `--include-inactive` on `projects`
- repeatable `--status <raw_status>` on `tasks`
- `--all` on `roles`

The former `--yaml` output mode was removed at the TypeScript cutover. Structured output uses stable `snake_case` keys. Successful JSON commands write only the result to stdout; failures leave stdout empty.

## Configuration

Set the deployment root URL:

```bash
export ONTRACK_BASE_URL='https://ontrack.example.edu'
```

Or create `config.yaml` in the current directory, `$XDG_CONFIG_HOME/ontrack-cli/config.yaml`, or `~/.config/ontrack-cli/config.yaml`:

```yaml
base_url: https://ontrack.example.edu
```

`ONTRACK_CONFIG` selects an explicit config file. Resolution order is:

1. `ONTRACK_CONFIG`
2. a current-directory `config.yaml`
3. the XDG or platform config directory

## Authentication

For normal interactive use, install and configure `okta-auth`, then establish the session explicitly:

```bash
uv tool install okta-auth-cli
okta config
ontrack auth login
```

`ontrack auth login` first looks for a matching `username` and `refresh_token` pair in local Chrome, Brave, Edge, and Firefox profiles. It exchanges the pair for an OnTrack access token without printing either credential. On macOS, Chromium access uses the system Keychain and may require Files and Folders permission; Firefox requires the `sqlite3` command. Unsupported or inaccessible profiles are skipped.

If browser import does not yield a usable pair, the command follows the deployment's advertised SAML sign-in URL and starts a visible `okta login`. It waits for OnTrack's application-side sign-in to finish before exporting cookies, so the landing page's manual **Sign in** redirect is not required. Normal commands never start an interactive login. Access sessions are cached in `session.json` beside the selected config with mode `0600` until expiry.

Automation can use an atomic credential pair:

```bash
export ONTRACK_USERNAME='your_username'
export ONTRACK_AUTH_TOKEN='your_auth_token'
```

Credential precedence is environment pair, config pair, migration-only `ONTRACK_DOUBTFIRE_USER_JSON`, cached access session, direct browser cookies, then the `okta` subprocess provider. Access and refresh tokens are never included in command output or diagnostics; refresh cookies are exchanged in memory and are not copied into the OnTrack session cache.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run test:bun
npm pack --dry-run
```

Tests export plain async functions and use `node:assert/strict`, so the same suite runs through the local harness under Node and Bun. `ONTRACK_NOW` is available only for deterministic test and verification runs.

See [ADR 0001](docs/adr/0001-typescript-7-dual-runtime-rewrite.md) and [PORTING.md](PORTING.md) for the cutover contract and module map.
