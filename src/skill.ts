interface DescribedCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly positionals: readonly { readonly name: string; readonly required: boolean; readonly variadic: boolean }[];
  readonly options: readonly { readonly flags: string }[];
  readonly mutating: boolean;
  readonly commands: readonly DescribedCommand[];
}

interface DescribedProgram {
  readonly name: string;
  readonly description: string;
  readonly commands: readonly DescribedCommand[];
}

// What a person says, mapped to the one command that answers it.
// UNIT and TASK are placeholders; the site's own lists are the vocabulary.
const INTENTS: readonly (readonly [string, string, string])[] = [
  ["which units am I in / how are units named here", "`ontrack units`", "`--include-inactive` for past units"],
  ["what's in UNIT / my target grade / overall progress", "`ontrack units show UNIT`", ""],
  ["which tasks / what's due / what needs work", "`ontrack tasks UNIT`", "`--status <status...>` to narrow"],
  ["what does task X say / the task sheet", "`ontrack tasks read UNIT TASK`", "Markdown; `tasks show` for status only"],
  ["download the task sheet / task resources", "`ontrack tasks get UNIT TASK [--resources] --dest PATH`", "`ontrack units get UNIT` for the whole unit"],
  ["any tutor feedback / unread messages", "`ontrack chats UNIT`", "unread counts per task"],
  ["read the tutor's comments on a task", "`ontrack chats read UNIT TASK --yes`", "marks them read upstream; tell the user first"],
  ["mark a task ready / working on it / need help (only when asked)", "`ontrack tasks set UNIT TASK STATE --dry-run`", "then repeat with `--yes`"],
  ["submit files for a task (only when asked)", "`ontrack tasks submit UNIT TASK --file F --dry-run`", "then repeat with `--yes`"],
  ["message the tutor on a task (only when asked)", "`ontrack chats send UNIT TASK --message \"...\" --dry-run`", "then repeat with `--yes`"],
  ["am I signed in / is it working", "`ontrack auth status`", "`ontrack auth login` to sign in"],
  ["my teaching roles", "`ontrack roles`", "`--all` includes inactive roles"],
];

function usage(command: DescribedCommand, parents: readonly string[]): string {
  const path = [...parents, command.name];
  const args = command.positionals.map((argument) => {
    const name = argument.variadic ? `${argument.name}...` : argument.name;
    return argument.required ? `<${name}>` : `[${name}]`;
  });
  return [...path, ...args].join(" ");
}

function commandLines(commands: readonly DescribedCommand[], parents: readonly string[]): string[] {
  return commands.flatMap((command) => {
    const aliases = command.aliases?.length ? ` (aliases: ${command.aliases.join(", ")})` : "";
    const chatRead = command.name === "read" && parents.at(-1) === "chats";
    const mutation = command.mutating
      ? chatRead ? " [mutating; requires --yes]" : " [mutating; requires confirmation or --yes]"
      : "";
    const line = `- \`${usage(command, parents)}\`${aliases} — ${command.description || "No description."}${mutation}`;
    return [line, ...commandLines(command.commands, [...parents, command.name])];
  });
}

function intentTable(): string[] {
  const escape = (value: string): string => value.replace(/\|/g, "\\|");
  return [
    "| The user says | Run | Notes |",
    "| --- | --- | --- |",
    ...INTENTS.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ];
}

export function renderSkill(program: DescribedProgram): string {
  return [
    "---",
    "name: ontrack-cli",
    `description: ${program.description}`,
    "---",
    "",
    "# OnTrack CLI",
    "",
    "Use `ontrack` to inspect and update OnTrack from a terminal. Start from what the user said, not from ids.",
    "",
    "## What the user says, and what to run",
    "",
    "`UNIT` is a project ID, or the unit's code or name exactly as OnTrack shows it; `ontrack units` is the vocabulary for this site. `TASK` is the task abbreviation shown by `ontrack tasks UNIT`, or a task definition ID. Never assume what a code or abbreviation looks like; if a reference matches several units the CLI lists their project IDs, so pick one rather than guess.",
    "",
    ...intentTable(),
    "",
    "## Contract",
    "",
    "- `units`, `courses`, and `projects` are interchangeable.",
    "- `ontrack commands --json` is the source of truth for this tool's command tree; the published `@bunizao/cli-kit` npm package (`^0.1.0`) defines the shared CLI contract.",
    "- Piped output defaults to JSON; terminal output defaults to a table.",
    "- Mutating commands require explicit user intent and an interactive y/N confirmation or `--yes`.",
    "- `chats read` is an upstream exception: it marks comments read and always requires `--yes`.",
    "- Use `--dry-run` before a mutation when the intended target is uncertain.",
    "- Never print or copy session tokens, browser cookies, or authentication files.",
    "",
    "## Commands",
    "",
    ...commandLines(program.commands, [program.name]),
    "",
    "Run `ontrack commands --json` for options, enum values, aliases, and mutation metadata.",
    "",
  ].join("\n");
}
