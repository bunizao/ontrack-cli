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
    const mutation = command.mutating ? " [mutating; requires confirmation or --yes]" : "";
    const line = `- \`${usage(command, parents)}\`${aliases} — ${command.description || "No description."}${mutation}`;
    return [line, ...commandLines(command.commands, [...parents, command.name])];
  });
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
    "Use `ontrack` to inspect and update OnTrack from a terminal. Prefer `--json` for automation.",
    "",
    "## Contract",
    "",
    "- `units`, `courses`, and `projects` are interchangeable.",
    "- `ontrack commands --json` is the source of truth for this tool's command tree; the tagged `@bunizao/cli-kit` v0.1.0 archive defines the shared CLI contract.",
    "- Piped output defaults to JSON; terminal output defaults to a table.",
    "- Mutating commands require an interactive y/N confirmation or `--yes`.",
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
