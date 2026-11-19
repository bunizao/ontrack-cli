<p align="center"><a href="https://unicorn.tuuhub.com"><img src=".github/assets/hero.jpg" alt="ontrack: OnTrack and Doubtfire from your terminal, scripts and AI agent, part of unicorn" width="100%"></a></p>

# ontrack

**Give your AI agent access to OnTrack.**

Check task status, read task sheets, download resources, follow up in task chats, and submit work. Works with OnTrack and Doubtfire, for students and teaching staff.

For Claude on the web, ChatGPT or your phone, `ontrack mcp deploy` runs a private MCP server on your own Cloudflare account. See [Remote MCP](#remote-mcp).

[![npm version](https://img.shields.io/npm/v/ontrack?logo=npm)](https://www.npmjs.com/package/ontrack)
[![CI](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/bunizao/ontrack-cli/actions/workflows/ci.yml)
[![Node.js 22.5+](https://img.shields.io/badge/Node.js-22.5%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-supported-fbf0df?logo=bun&logoColor=black)](https://bun.sh/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 🦄 Part of [unicorn](https://unicorn.tuuhub.com). Live tools answer what is there now; unicorn answers what changed.
>
> 📖 **[Read the docs](https://unicorn.tuuhub.com/docs/ontrack)**

## Set up

Ask your agent (Claude Code, Codex, or anything with a terminal):

```text
Read https://unicorn.tuuhub.com/docs/ontrack/agent-setup.md and set up ontrack for me.
```

Or by hand:

```bash
npm install -g ontrack
export ONTRACK_BASE_URL="https://ontrack.example.edu"
ontrack auth login
ontrack courses
```

Set `ONTRACK_BASE_URL` to your institution's OnTrack site.

Tick "Remember me" when you sign in. OnTrack only issues the renewal cookie then, and the CLI needs it to renew your session in the background.

## Study Boooooooooost

Ask in plain language, or run the command yourself:

| Ask your agent | Command |
| --- | --- |
| “What are my units?” | `ontrack courses` |
| “Where am I with the tasks in UNIT?” | `ontrack tasks UNIT` |
| “Read me the task sheet for TASK.” | `ontrack tasks read UNIT TASK` |
| “Any new tutor feedback?” | `ontrack chats UNIT` |
| “Download everything for UNIT.” | `ontrack courses get UNIT --dest unit.zip` |
| “Submit my report for TASK.” | `ontrack tasks submit UNIT TASK --file report.pdf` |

`UNIT` is the unit's code or name as OnTrack shows it. `courses`, `units` and `projects` are interchangeable. `TASK` is the task abbreviation. Writes always show a plan and ask first.

## Remote MCP

Use OnTrack from Claude on the web, ChatGPT or your phone. `ontrack mcp deploy` puts a private MCP server on your own Cloudflare account (the free plan covers it). It signs in to OnTrack through Okta by itself and renews the session before it lapses, so you set it up once.

Ask your agent:

```text
Read https://unicorn.tuuhub.com/docs/ontrack/agent-setup.md and set up remote MCP for ontrack.
```

It runs the commands; you do three things in your browser: save your Okta password and authenticator secret on the page `okta-auth setup` opens, approve Cloudflare, and type a pairing code when your AI app asks.

Or by hand:

```bash
npm install -g okta-auth-cli
okta-auth setup
npx wrangler login
ontrack mcp deploy
```

`deploy` prints a URL and an eight-character pairing code. Add the URL as a custom connector in Claude, ChatGPT or another MCP client; the approval page it opens asks for the code. A code lasts ten minutes and approves one client; `ontrack mcp pair` prints a new one. `ontrack mcp status` shows when the session renews.

The server reads your units, tasks, task sheets and chats. It submits nothing. Reading a task's comments marks them read, as the website does.

OnTrack keeps one renewal token per user, so the Worker and this CLI share it. When the Worker renews, the CLI signs in through Okta once on its next run, and the other way round.

## Learn more

- [Install](https://unicorn.tuuhub.com/docs/ontrack/install) and [sign in](https://unicorn.tuuhub.com/docs/ontrack/sign-in)
- [Units and tasks](https://unicorn.tuuhub.com/docs/ontrack/units-and-tasks)
- [Task workflow](https://unicorn.tuuhub.com/docs/ontrack/task-workflow)
- [Chats](https://unicorn.tuuhub.com/docs/ontrack/chats)
- [Downloads](https://unicorn.tuuhub.com/docs/ontrack/downloads)
- [Teaching roles](https://unicorn.tuuhub.com/docs/ontrack/roles)
- [Configuration](https://unicorn.tuuhub.com/docs/ontrack/configuration)
- [Troubleshooting](https://unicorn.tuuhub.com/docs/ontrack/troubleshooting)
- [Command reference](https://unicorn.tuuhub.com/docs/ontrack/reference)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## 🦄 Part of unicorn

Live tools answer what is there now; unicorn answers what changed.

| Project | Layer | What it does |
| --- | --- | --- |
| [🦄 unicorn](https://github.com/TuuHub/unicorn) | Memory | Remembers your campus sources and tells your agent what changed. Remote MCP. |
| [moodle-cli](https://github.com/bunizao/moodle-cli) | Live | Moodle. CLI, local and remote MCP. |
| [edstem-cli](https://github.com/bunizao/edstem-cli) | Live | Ed Discussion. CLI, local and remote MCP. |
| **[ontrack](https://github.com/bunizao/ontrack-cli)** (you are here) | **Live** | **OnTrack and Doubtfire. CLI only.** |

📖 [All docs](https://unicorn.tuuhub.com/docs) · [CLIs overview](https://unicorn.tuuhub.com/cli) · [Connect an MCP client](https://unicorn.tuuhub.com/docs/mcp)

## License

[MIT](LICENSE)
