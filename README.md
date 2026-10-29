<p align="center"><a href="https://unicorn.tuuhub.com"><img src=".github/assets/hero.jpg" alt="ontrack: OnTrack and Doubtfire from your terminal, scripts and AI agent, part of unicorn" width="100%"></a></p>

# ontrack

**Give your AI agent access to OnTrack.**

Check task status, read task sheets, download resources, follow up in task chats, and submit work. Works with OnTrack and Doubtfire, for students and teaching staff.

It is a CLI only for now. There is no MCP server, so web AI cannot connect to it directly.

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
