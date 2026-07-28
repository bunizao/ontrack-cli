# ontrack

[![CI](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml)

Terminal-first CLI for OnTrack and Doubtfire. The same emitted JavaScript runs on Node.js and Bun.

## Install

Requires Node.js 22.5 or newer, or Bun.

```bash
npm install --global ontrack
```

## Command model

Commands follow one grammar:

```text
ontrack <noun> [verb] [scope] [id] [flags]
```

`units`, `courses`, and `projects` are interchangeable. The verb is inferred when its positional arity is unambiguous:

```bash
ontrack units                         # units list
ontrack courses FIT1045               # units show FIT1045
ontrack tasks FIT1045                 # tasks list FIT1045
ontrack tasks FIT1045 1.1             # tasks show FIT1045 1.1
ontrack chats FIT1045 1.1 --yes       # chats read FIT1045 1.1
```

The normalized command surface is:

```text
auth login | status | logout
user
units list | show | get
tasks list | show | read | get | set | submit
chats list | read | mark-read | send
roles list
commands
skills generate
```

Run `ontrack commands --json` for the full command tree, aliases, positionals, options, enum values, and mutation metadata. The shared contract is supplied by the published `@bunizao/cli-kit` npm package (`^0.1.0`).

## Output

Output defaults from stdout:

- terminal: table
- pipe or file: JSON

All commands share:

```text
--json | --yaml | --table
--fields id,name
-o, --output FILE
-q, --quiet
--verbose
--no-color
```

`--json`, `--yaml`, and `--table` are mutually exclusive. `tasks read` emits Markdown because Markdown is the command's payload, not an output flag.

## Authentication and configuration

```bash
ontrack auth login
ontrack auth status
ontrack auth logout
```

Configuration is read from `~/.config/ontrack-cli/config.yaml` by default. The standard environment variables are:

```text
ONTRACK_BASE_URL
ONTRACK_TOKEN
ONTRACK_CONFIG
```

OnTrack also requires `ONTRACK_USERNAME` when a token is supplied directly. `ONTRACK_AUTH_TOKEN` remains a compatibility fallback for pre-normalization setups.

Example:

```bash
export ONTRACK_BASE_URL='https://ontrack.example.edu'
export ONTRACK_USERNAME='student'
export ONTRACK_TOKEN='your_access_token'
ontrack units --json
```

Never copy session files, browser cookies, usernames, or tokens into issues, logs, fixtures, or agent prompts.

## Mutations

`send`, `submit`, `set`, and `mark-read` show a plan and require a plain `y/N` confirmation in an interactive terminal. Non-interactive callers must pass `--yes`.

```bash
ontrack tasks set FIT1045 1.1 working_on_it --dry-run
ontrack chats send FIT1045 1.1 --message 'Please review this.' --yes
```

`chats read` is separated from `chats mark-read`, but the current OnTrack history endpoint itself marks non-discussion comments read. It always requires `-y`/`--yes` and prints that side effect on stderr before fetching history.

Downloads use `--dest`; global `-o/--output` always redirects structured CLI output. Pass `--force` to replace an existing download atomically.

## License

MIT
