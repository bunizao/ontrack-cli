<p align="center"><a href="https://unicorn.tuuhub.com"><img src=".github/assets/hero.jpg" alt="ontrack: OnTrack and Doubtfire from your terminal, scripts and AI agent, part of unicorn" width="100%"></a></p>

# ontrack

**Give your AI agent access to OnTrack.**

Let it check task status, read task sheets, download unit resources, follow up in task chats, and submit work when you ask. Built for students, teaching staff, scripts and agents on OnTrack and Doubtfire. It is a CLI only for now: there is no MCP server, so web AI cannot connect to it directly.

[![npm version](https://img.shields.io/npm/v/ontrack?logo=npm)](https://www.npmjs.com/package/ontrack)
[![CI](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml)
[![Node.js 22.5+](https://img.shields.io/badge/Node.js-22.5%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-supported-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 🦄 **Part of [unicorn](https://unicorn.tuuhub.com).** Live tools answer what is there now; unicorn answers what changed.
>
> 📖 **[Read the docs → unicorn.tuuhub.com/docs/ontrack](https://unicorn.tuuhub.com/docs/ontrack)**

## Quick start

```bash
npm install -g ontrack
export ONTRACK_BASE_URL="https://ontrack.example.edu"
ontrack auth login
ontrack units
```

## Quick links

- [Install and sign in](#install-and-sign-in)
- [Study Boooooooooost](#study-boooooooooost)
- [Developer and agent reference](#for-developers-and-agents)

## Install and sign in

### Install

```bash
npm install -g ontrack
bun add -g ontrack

# No global install
bunx --bun ontrack --version
```

Point it at your institution's OnTrack site with `ONTRACK_BASE_URL`, or save it in `~/.config/ontrack-cli/config.yaml`:

```yaml
base_url: https://ontrack.example.edu
```

### Sign in

```bash
ontrack auth login
ontrack auth status
ontrack doctor
```

`auth login` opens Chrome, Edge, Brave or Chromium with a private CLI profile. Finish your institution's sign-in there and the CLI captures the session itself, without reading your everyday browser or asking you to paste anything. Tick "Remember me" so OnTrack issues a renewal cookie; the CLI then renews expired tokens in the background, and warns a day before that cookie lapses.

Other paths: `--reuse-browser` tries your existing browser session, and `--paste` takes a Cookie header or cURL command without echoing it. The session is encrypted at rest in `~/.config/ontrack-cli/session.json`. Every path, renewal rule and diagnostic: [docs/auth.md](docs/auth.md).

## Study Boooooooooost

Ask your agent in plain language or run the matching command:

| Student request | CLI command |
| --- | --- |
| “What are my units?” | `ontrack units` |
| “Where am I with the tasks in UNIT?” | `ontrack tasks UNIT` |
| “Read me the task sheet for TASK.” | `ontrack tasks read UNIT TASK` |
| “Download everything for UNIT.” | `ontrack units get UNIT --dest unit-resources.zip` |
| “Mark TASK as working on it.” | `ontrack tasks set UNIT TASK working_on_it` |

`UNIT` is a project ID, or the unit's code or name exactly as OnTrack shows it; a reference matching several units lists their project IDs. `TASK` is the abbreviation shown by `ontrack tasks UNIT`, or a task definition ID.

Commands follow `ontrack <noun> [verb] [args] [flags]`. `courses` and `projects` are aliases for `units`, and the verb can be left out when the arguments identify one command.

```bash
ontrack units
ontrack tasks UNIT TASK
ontrack chats UNIT
ontrack roles
```

### Download files

```bash
ontrack units get UNIT --dest unit-resources.zip
ontrack tasks get UNIT TASK --dest task-sheet.pdf
ontrack tasks get UNIT TASK --resources
```

Downloads never replace an existing file unless you pass `--force`. Use `--dest` for downloads; global `-o/--output` writes command output.

### Write to OnTrack

Every write prints a plan and asks `y/N`. Scripts pass `--yes`; `--dry-run` shows the target without sending anything. In a terminal, a missing unit or task is asked for with a picker.

```bash
ontrack tasks set UNIT TASK working_on_it --dry-run
ontrack chats send UNIT TASK --message "Please review this." --yes
ontrack tasks submit UNIT TASK --file report.pdf --yes
```

`chats read` also needs `--yes`: OnTrack's history endpoint marks non-discussion comments as read when it is fetched.

```bash
ontrack chats read UNIT TASK --yes
```

## For developers and agents

### Command and output contract

```bash
ontrack commands --json
```

prints the full command tree, including aliases, positionals, options, enum values and which commands write.

- Output is a table in a terminal and JSON in a pipe; force one with `--json`, `--yaml` or `--table`.
- `--fields a,b` selects top-level fields; `--output FILE` writes to a file.
- In a terminal, a missing unit or task asks with a picker; pipes, `--json` and agent shells get a usage error instead.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Configuration or network error |
| 2 | Usage error |
| 3 | Authentication error |
| 4 | Unit or task not found |
| 5 | OnTrack rejected the request |
| 130 | Cancelled |

### Agent skill

```bash
npx skills add https://github.com/bunizao/ontrack-cli
```

[`SKILL.md`](SKILL.md) is generated from `ontrack commands --json` with `ontrack skills generate`.

### Configuration

| Variable | Purpose |
| --- | --- |
| `ONTRACK_BASE_URL` | OnTrack site root. |
| `ONTRACK_USERNAME` | Your username, when you supply a token. |
| `ONTRACK_TOKEN` | An access token for automation. |
| `ONTRACK_CONFIG` | Use another config file. |

Set `ONTRACK_USERNAME` and `ONTRACK_TOKEN` together for automation; `ONTRACK_AUTH_TOKEN` still works for older setups, and the config file accepts `username` and `auth_token`. Keep session files, cookies, usernames and tokens out of logs, issues, fixtures and agent prompts.

### Build from source

See [CONTRIBUTING.md](CONTRIBUTING.md).

## 🦄 Part of unicorn

unicorn is one project in two layers. The live tools answer what is there now; unicorn answers what changed.

| Project | Layer | What it does |
| --- | --- | --- |
| [🦄 unicorn](https://github.com/TuuHub/unicorn) | Memory | A Cloudflare Worker on your own account. Reads Moodle, Ed, Canvas, Gmail and feeds every hour, remembers what each said, and tells your AI agent what changed. Remote MCP. |
| [moodle-cli](https://github.com/bunizao/moodle-cli) | Live | Moodle: units, deadlines, grades, forums, files, submissions. CLI, local and remote MCP. |
| [edstem-cli](https://github.com/bunizao/edstem-cli) | Live | Ed Discussion: units, threads, lessons, files, posting. CLI, local and remote MCP. |
| **[ontrack](https://github.com/bunizao/ontrack-cli)** (you are here) | **Live** | **OnTrack / Doubtfire: units, tasks, chats, submissions. CLI only.** |

The three CLIs share one command contract through [@bunizao/cli-kit](https://github.com/bunizao/cli-kit).

📖 **Docs:** [this project](https://unicorn.tuuhub.com/docs/ontrack) · [all projects](https://unicorn.tuuhub.com/docs) · [CLIs overview](https://unicorn.tuuhub.com/cli) · [MCP clients](https://unicorn.tuuhub.com/docs/mcp)

## License

[MIT](LICENSE)
