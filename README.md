# ontrack

CLI access to OnTrack and Doubtfire for students, teaching staff, scripts, and agents. Runs on Node.js 22.5+ and Bun.

[![npm version](https://img.shields.io/npm/v/ontrack?logo=npm)](https://www.npmjs.com/package/ontrack)
[![CI](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml)
[![Node.js 22.5+](https://img.shields.io/badge/Node.js-22.5%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Install

With npm:

```bash
npm install -g ontrack
```

With Bun:

```bash
bun add -g ontrack
```

Then configure your OnTrack site and sign in:

```bash
export ONTRACK_BASE_URL="https://ontrack.example.edu"
ontrack auth login
ontrack auth status
```

Run the CLI through Bun without a global install:

```bash
bunx --bun ontrack --version
```

Set `ONTRACK_BASE_URL` to the root URL of your institution's OnTrack site. You can put it in `~/.config/ontrack-cli/config.yaml` instead:

```yaml
base_url: https://ontrack.example.edu
```

## Sign in

```bash
ontrack auth login
ontrack auth status
```

`auth login` offers three sign-in paths in a terminal. The recommended path opens Chrome, Edge, Brave, or Chromium with a private CLI profile. Complete your institution's sign-in in that window; the CLI captures and validates the OnTrack session automatically, without reading your normal browser's files or asking you to paste anything.

Choose a path directly:

```bash
ontrack auth login --browser
ontrack auth login --reuse-browser
ontrack auth login --paste
```

`--reuse-browser` tries your existing browser session with a bounded cookie-store read. If reuse is unavailable, it opens your SAML sign-in page and prints a one-time snippet to paste into the OnTrack tab's DevTools console. `--paste` goes straight to that manual flow.

The CLI encrypts the access-token cache in `~/.config/ontrack-cli/session.json` with AES-256-GCM and owner-only permissions. Existing plaintext caches migrate when read. The key uses macOS Keychain, Windows DPAPI, or Linux Secret Service. Linux systems without Secret Service use a private key file under `~/.config/ontrack-cli/keys/`; that fallback relies on your filesystem permissions for protection.

The private browser profile is stored under `~/.config/ontrack-cli/browser/`, separately for each site. When an access token expires or a read request rejects it, the CLI first tries to renew through that profile in a background browser. If your institution's SSO session has expired, run `auth login` again. `auth logout` removes both the access-token cache and the CLI browser profiles.

## Command model

Commands follow `ontrack <plural-noun> [verb] [scope] [id] [flags]`. The canonical enrolment noun is `units`; `courses` and `projects` are equivalent aliases.

```bash
ontrack units
ontrack courses UNIT
ontrack tasks UNIT
ontrack tasks UNIT TASK
ontrack tasks read UNIT TASK
ontrack chats UNIT
ontrack roles
```

`UNIT` is a project ID, or the unit's code or name exactly as OnTrack shows it (run `ontrack units` to see them). The CLI never assumes what a code looks like; if a reference matches several units it lists their project IDs. `TASK` is the task abbreviation shown by `ontrack tasks UNIT`, or a task definition ID.

The CLI infers omitted verbs when the arguments identify one command. `tasks read` prints the task sheet as Markdown.

Run `ontrack commands --json` for the machine-readable command tree, including aliases, positionals, options, enum values, and mutation markers.

## Downloads

Download all resources for a unit, a task sheet, or the files linked from one task:

```bash
ontrack units get UNIT --dest unit-resources.zip
ontrack tasks get UNIT TASK --dest task-sheet.pdf
ontrack tasks get UNIT TASK --resources
```

Downloads refuse to replace an existing destination. Pass `--force` to replace it with an atomic rename. Global `-o/--output` writes CLI output to a file; downloads use `--dest`.

## Mutations

Commands that change OnTrack print a plan and prompt with `y/N` in a terminal. Scripts must pass `--yes`. Use `--dry-run` to inspect the target without sending a write request.

In a terminal, a command missing its unit or task asks for it with a picker: `ontrack tasks` lists your units, then the unit's tasks. Pipes, `--json` and agent shells get the usage error with the usage line instead.

```bash
ontrack tasks set UNIT TASK working_on_it --dry-run
ontrack chats send UNIT TASK --message "Please review this." --yes
ontrack tasks submit UNIT TASK --file report.pdf --yes
```

The OnTrack history endpoint marks non-discussion comments as read. For that reason, `chats read` requires `--yes` and prints a warning before it fetches the history:

```bash
ontrack chats read UNIT TASK --yes
```

## Output and errors

The CLI prints a table when stdout is a terminal and JSON when stdout is piped or redirected. Use `--json`, `--yaml`, or `--table` to select a format; `--fields a,b` selects top-level fields, and `--output FILE` writes the result to a file.

Errors go to stderr. Configuration and network failures exit 1, usage failures exit 2, authentication failures exit 3, missing entities exit 4, upstream rejections exit 5, and cancellation exits 130.

## Environment

| Variable | Purpose |
| --- | --- |
| `ONTRACK_BASE_URL` | Set the OnTrack site root. |
| `ONTRACK_USERNAME` | Identify the user when you supply a token. |
| `ONTRACK_TOKEN` | Supply an access token for automation. |
| `ONTRACK_CONFIG` | Override the config file path. |

Set `ONTRACK_USERNAME` and `ONTRACK_TOKEN` together for automation. `ONTRACK_AUTH_TOKEN` remains available for older setups. The CLI also accepts `username` and `auth_token` in the config file. Keep session files, browser cookies, usernames, and tokens out of logs, issues, fixtures, and agent prompts.

## Agent skill

```bash
npx skills add https://github.com/bunizao/ontrack-cli
ontrack skills generate
```

The tracked [SKILL.md](SKILL.md) comes from `ontrack commands --json`. The package uses the shared [`@bunizao/cli-kit`](https://www.npmjs.com/package/@bunizao/cli-kit) command contract.

## License

[MIT](LICENSE)
