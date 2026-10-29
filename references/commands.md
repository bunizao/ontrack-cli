# ontrack commands

Generated from `ontrack commands --json` for version 0.3.2.

| Command | Description | Arguments | Options | Mutating |
| --- | --- | --- | --- | --- |
| `ontrack user` | Show the signed-in user |  |  | no |
| `ontrack auth` | Manage authentication |  |  | no |
| `ontrack auth login` | Sign in through OnTrack |  |  | no |
| `ontrack auth status` | Validate current credentials |  |  | no |
| `ontrack auth logout` | Remove the cached session |  |  | no |
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
| `ontrack skills generate` | Write SKILL.md and the plugin files into the current directory |  |  | no |
