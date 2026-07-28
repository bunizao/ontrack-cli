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
- Convert a task-sheet PDF to Markdown in memory for agents and shell pipelines.
- Read task chats and send confirmed text messages.
- Change student task states and submit ordered task files after confirmation.
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
| `ontrack project <project>` | Show a project and its task snapshot. |
| `ontrack tasks <project>` | List tasks for a project. |
| `ontrack resources download <project>` | Download the project's unit-wide resource ZIP. |
| `ontrack task sheet <project> <task>` | Download one task sheet. |
| `ontrack task resources <project> <task>` | Download one task's linked file or resource ZIP. |
| `ontrack task read <project> <task>` | Print a task sheet as Markdown without creating a PDF file. |
| `ontrack task state <project> <task> <state>` | Set `not_started`, `working_on_it`, or `need_help`. |
| `ontrack task submit <project> <task> --file <path>` | Submit files in the order required by the task. |
| `ontrack chats <project>` | List tasks and unread comment counts without opening chat streams. |
| `ontrack chats <project> <task>` | Show one task's chronological comment history. |
| `ontrack chats send <project> <task> --message <text>` | Send one text message after confirmation. |
| `ontrack roles` | List teaching and administrative roles. |

Commands print tables by default. Use `--json` for automation:

```bash
ontrack projects --include-inactive --json
ontrack tasks FIT1045 --status rediscuss --json
ontrack chats FIT1045 --json
ontrack chats FIT1045 1.1 --json
ontrack chats send FIT1045 1.1 --message "Please review this"
ontrack task sheet FIT1061 1.1 --output FIT1061-1.1.pdf --json
ontrack task resources FIT1061 1.1 --output 1.1-resources.zip --json
ontrack task read FIT1061 1.1 > FIT1061-1.1.md
ontrack task state FIT1061 1.1 working_on_it
ontrack task submit FIT1061 1.1 --file report.pdf --file source.zip
ontrack resources download FIT1061 --output FIT1061-resources.zip --json
ontrack roles --all --json
```

`<project>` accepts a unit code such as `FIT1045` or the `id` from `ontrack projects --include-inactive`. The CLI uses a unit code only when it identifies one project. If current and past projects share a code, use the project ID. List positions are never project IDs.

The task selector accepts an abbreviation shown by `ontrack project`; a task-definition ID is also accepted. When OnTrack has not generated project task instances, the project table lists the authorized unit definitions that remain available for download. Server filenames are used when possible. Existing files are never replaced, downloads are written atomically, and large ranged responses are assembled before the file is committed.

`task read` downloads the task sheet into memory and converts it with the bundled PDF parser. The Markdown keeps inferred headings, lists, code blocks, links, and page-break markers where the source exposes enough layout information. It requires no `pdftotext` executable and writes no local file unless stdout is redirected. Image-only PDFs require OCR and return an explicit error.

`resources download` retrieves the complete unit archive exposed by OnTrack. It is not filtered to the student's current task rows. The archive does not include general unit website content.

`chats <project>` reads unread counts from the project snapshot and does not open comment streams. Reading one task's history causes OnTrack to mark returned non-discussion comments as read; the CLI prints this side effect to stderr before presenting the result.

`chats send` is a remote mutation. It shows the exact destination and message in an interactive terminal and requires typing `send`. Non-interactive use must pass `--yes` only after the user has explicitly approved that project, task, and message. Text messages are limited to 4,095 characters; attachments and replies are not supported by this command.

`task submit` reads the task's upload requirements and pairs each repeated `--file` with `file0`, `file1`, and later fields in server order. It rejects missing, empty, oversized, non-regular, and symbolic-link inputs before the POST. The default type is `ready_for_feedback`; `need_help` and `assess_in_portfolio` are also supported. Use `--accept-tii-eula` only when you accept the Turnitin EULA for that submission.

Interactive submission shows the project, task, type, and file mapping, then requires `submit <task>`. Non-interactive use requires `--yes` after the user approves those exact values. A successful HTTP 201 means OnTrack accepted the files for asynchronous processing; it does not mean the final PDF is ready. The CLI returns server validation errors for file types, prerequisites, group membership, pending submissions, and feedback comments.

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
