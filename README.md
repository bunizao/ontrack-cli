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

`auth login` reuses an active Firefox or Chrome session when available. If it cannot, the CLI opens your SAML sign-in page and prints a one-time snippet. Sign in, then paste the snippet into the OnTrack tab's DevTools console.

The CLI saves the session to `~/.config/ontrack-cli/session.json` by default. The fallback needs no browser file permissions.

## Command model

Commands follow `ontrack <plural-noun> [verb] [scope] [id] [flags]`. The canonical enrolment noun is `units`; `courses` and `projects` are equivalent aliases.

```bash
ontrack units
ontrack courses FIT1045
ontrack tasks FIT1045
ontrack tasks FIT1045 1.1
ontrack tasks read FIT1045 1.1
ontrack chats FIT1045
ontrack roles
```

The CLI infers omitted verbs when the arguments identify one command. `tasks read` prints the task sheet as Markdown.

Run `ontrack commands --json` for the machine-readable command tree, including aliases, positionals, options, enum values, and mutation markers.

## Downloads

Download all resources for a unit, a task sheet, or the files linked from one task:

```bash
ontrack units get FIT1045 --dest FIT1045-resources.zip
ontrack tasks get FIT1045 1.1 --dest task-1.1.pdf
ontrack tasks get FIT1045 1.1 --resources
```

Downloads refuse to replace an existing destination. Pass `--force` to replace it with an atomic rename. Global `-o/--output` writes CLI output to a file; downloads use `--dest`.

## Mutations

Commands that change OnTrack print a plan and prompt with `y/N` in a terminal. Scripts must pass `--yes`. Use `--dry-run` to inspect the target without sending a write request.

```bash
ontrack tasks set FIT1045 1.1 working_on_it --dry-run
ontrack chats send FIT1045 1.1 --message "Please review this." --yes
ontrack tasks submit FIT1045 1.1 --file report.pdf --yes
```

The OnTrack history endpoint marks non-discussion comments as read. For that reason, `chats read` requires `--yes` and prints a warning before it fetches the history:

```bash
ontrack chats read FIT1045 1.1 --yes
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
