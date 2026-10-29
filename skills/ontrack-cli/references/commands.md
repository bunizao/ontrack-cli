# ontrack commands

Generated from `ontrack commands --json` for version 0.3.2.

| Command | Description | Arguments | Options | Mutating |
| --- | --- | --- | --- | --- |
| `ontrack user` | Show the signed-in user |  |  | no |
| `ontrack auth` | Manage authentication |  |  | no |
| `ontrack auth login` | Sign in through OnTrack |  | --browser<br>--reuse-browser<br>--paste<br>--manual<br>--username <username> | no |
| `ontrack auth status` | Validate current credentials |  | --local | no |
| `ontrack auth keepalive` | Renew and verify the session once without an interactive sign-in |  |  | no |
| `ontrack auth logout` | Remove the cached session |  |  | no |
| `ontrack doctor` | Diagnose authentication, cache, browser, and site discovery |  | --live<br>--cookies | no |
| `ontrack courses` | Enrolled units |  |  | no |
| `ontrack courses list` | List units |  | --include-inactive | no |
| `ontrack courses show` | Show one unit | <unit> |  | no |
| `ontrack courses get` | Download unit resources | <unit> | --dest <path><br>--force | no |
| `ontrack tasks` | Tasks in a unit: list, read, submit, set state |  |  | no |
| `ontrack tasks list` | List tasks | <unit> | --status <status...> | no |
| `ontrack tasks show` | Show one task | <unit> <task> |  | no |
| `ontrack tasks read` | Print a task sheet as Markdown | <unit> <task> |  | no |
| `ontrack tasks get` | Download a task sheet or resources | <unit> <task> | --resources<br>--dest <path><br>--force | no |
| `ontrack tasks set` | Change task workflow state | <unit> <task> <state> |  | yes |
| `ontrack tasks submit` | Submit task files | <unit> <task> | --file <path...><br>--type <type><br>--comment <text><br>--accept-tii-eula | yes |
| `ontrack chats` | Read and send task chat messages |  |  | no |
| `ontrack chats list` | List unread chat counts | <unit> |  | no |
| `ontrack chats read` | Read task chat history and mark comments read | <unit> <task> |  | yes |
| `ontrack chats mark-read` | Mark task chat comments read | <unit> <task> |  | yes |
| `ontrack chats send` | Send a task chat message | <unit> <task> | --message <text> | yes |
| `ontrack roles` | Teaching roles you hold |  |  | no |
| `ontrack roles list` | List teaching roles |  | --all | no |
| `ontrack commands` | Describe the complete command tree |  |  | no |
| `ontrack skills` | Generate the agent skill |  |  | no |
| `ontrack skills generate` | Write the skill folder and plugin files into the current directory |  |  | no |

## Exit codes

With `--json`, a failure is one `{ ok: false, error: { code, message, hint } }` object on stderr.

| Exit | Error code |
| --- | --- |
| 0 | success |
| 2 | usage |
| 3 | auth |
| 1 | config |
| 4 | not_found |
| 5 | upstream |
| 1 | network |
| 130 | cancelled |
| 1 | unexpected |
