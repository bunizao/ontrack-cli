import { parseArgs } from "node:util";

import { CliError, exitCodeFor } from "./errors.js";
import { renderJson, renderTable } from "./render.js";

export interface CliApplication {
  user(): Promise<unknown>;
  authCheck(): Promise<unknown>;
  projects(options: { readonly includeInactive: boolean }): Promise<unknown>;
  project(projectId: number): Promise<unknown>;
  tasks(projectId: number, options: { readonly statuses: readonly string[] }): Promise<unknown>;
  resourcesDownload(projectId: number, options: { readonly output?: string }): Promise<unknown>;
  taskSheetDownload(projectId: number, task: string, options: { readonly output?: string }): Promise<unknown>;
  taskResourcesDownload(projectId: number, task: string, options: { readonly output?: string }): Promise<unknown>;
  chats(projectId: number, options: { readonly task?: string }): Promise<unknown>;
  roles(options: { readonly showAll: boolean }): Promise<unknown>;
}

export interface CliExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Dependencies {
  readonly app: CliApplication;
  readonly authLogin?: () => Promise<unknown>;
  readonly version: string;
  readonly sensitiveValues?: readonly string[];
  readonly onDiagnostic?: (message: string) => void;
}

type OutputView = "auth-check" | "auth-login" | "chats-history" | "chats-summary" | "download" | "project" | "projects" | "roles" | "tasks" | "user";

interface InvocationResult {
  readonly value: unknown;
  readonly json: boolean;
  readonly view: OutputView;
  readonly emptyMessage?: string;
  readonly diagnostic?: string;
}

const secretKeys = new Set([
  "authentication_token",
  "auth_token",
  "access_token",
  "refresh_token",
  "authenticationToken",
  "authToken",
  "accessToken",
  "refreshToken",
]);

function sanitized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitized);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretKeys.has(key)) continue;
    const safe = sanitized(item);
    if (typeof safe === "object" && safe !== null && !Array.isArray(safe) && Object.keys(safe).length === 0) continue;
    result[key] = safe;
  }
  return result;
}

function redact(text: string, values: readonly string[]): string {
  return values.reduce((current, value) => value ? current.split(value).join("[REDACTED]") : current, text);
}

function rootHelp(): string {
  return [
    "Usage: ontrack <command> [options]",
    "",
    "Commands:",
    "  user                 Show the resolved signed-in user",
    "  auth check           Validate current credentials",
    "  auth login           Sign in through OnTrack in a browser",
    "  projects             List current projects",
    "  project <project_id> Show one project",
    "  tasks <project_id>   List project tasks",
    "  resources download <project_id> Download project resources",
    "  task sheet <project_id> <task> Download one task sheet",
    "  task resources <project_id> <task> Download one task's resources",
    "  chats <project_id> [task] Show unread chat counts or one task's history",
    "  roles                List teaching roles",
    "",
    "Project arguments use the id from `ontrack projects`, not list positions.",
    "",
    "Options:",
    "  --json               Output JSON",
    "  --help               Show help",
    "  --version            Show version",
    "",
  ].join("\n");
}

function commandHelp(usage: string, description: string, options: readonly string[], note?: string): string {
  return [
    `Usage: ${usage} [options]`,
    "",
    description,
    ...(note ? ["", note] : []),
    "",
    "Options:",
    ...options,
    "  --json               Output JSON instead of a table",
    "  --help               Show help",
    "",
  ].join("\n");
}

function helpFor(argv: readonly string[]): string | undefined {
  const args = argv.filter((argument) => argument !== "--help");
  const key = args.slice(0, 2).join(" ");
  if (args.length === 0) return rootHelp();
  if (args.length === 1 && args[0] === "auth") {
    return "Usage: ontrack auth <command>\n\nCommands:\n  check    Validate current credentials\n  login    Sign in through OnTrack in a browser\n";
  }
  if (args.length === 1 && args[0] === "resources") {
    return "Usage: ontrack resources <command>\n\nCommands:\n  download <project_id> Download all task sheets and resources\n";
  }
  if (args.length === 1 && args[0] === "task") {
    return "Usage: ontrack task <command>\n\nCommands:\n  sheet <project_id> <task>     Download one task sheet\n  resources <project_id> <task> Download one task's resources\n";
  }
  if (args[0] === "user") return commandHelp("ontrack user", "Show the resolved signed-in user.", []);
  if (key === "auth check") return commandHelp("ontrack auth check", "Validate current credentials.", []);
  if (key === "auth login") return commandHelp("ontrack auth login", "Reuse browser cookies or open the OnTrack SAML sign-in URL.", []);
  if (args[0] === "projects") return commandHelp("ontrack projects", "List projects available to the signed-in user.", ["  --include-inactive   Include past projects"]);
  if (args[0] === "project") return commandHelp(
    "ontrack project <project_id>",
    "Show a project and its task snapshot.",
    [],
    "Use the ID shown by `ontrack projects --include-inactive`, not list positions.",
  );
  if (args[0] === "tasks") return commandHelp(
    "ontrack tasks <project_id>",
    "List project tasks.",
    ["  --status <status>    Match a raw task status; repeat to match more than one"],
    "Use the ID shown by `ontrack projects --include-inactive`, not list positions.",
  );
  if (key === "resources download") return commandHelp(
    "ontrack resources download <project_id>",
    "Download all task sheets and resources for the project's unit.",
    ["  --output <path>      Destination ZIP; defaults to ontrack-resources-<project_id>.zip"],
    "Existing files are never replaced. Project IDs are not list positions.",
  );
  if (key === "task sheet") return commandHelp(
    "ontrack task sheet <project_id> <task>",
    "Download one task sheet by an abbreviation shown in `ontrack project`.",
    ["  --output <path>      Destination PDF; defaults to <unit>-<task>.pdf"],
    "A numeric task-definition ID is accepted as a fallback. Existing files are never replaced.",
  );
  if (key === "task resources") return commandHelp(
    "ontrack task resources <project_id> <task>",
    "Download one task's linked file or resource ZIP using an abbreviation shown in `ontrack project`.",
    ["  --output <path>      Destination path; defaults to the server filename"],
    "A numeric task-definition ID is accepted as a fallback. Existing files are never replaced.",
  );
  if (args[0] === "chats") return commandHelp(
    "ontrack chats <project_id> [task]",
    "Show per-task unread counts, or one task's chronological chat history.",
    [],
    "Viewing one task's history marks its non-discussion comments as read in OnTrack.",
  );
  if (args[0] === "roles") return commandHelp("ontrack roles", "List teaching and administrative roles.", ["  --all                 Include inactive roles"]);
  return undefined;
}

function projectId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new CliError("usage", "project_id must be an integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new CliError("usage", "project_id must be a positive safe integer");
  return id;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return record(value[key]);
}

function personName(value: unknown): string {
  const person = record(value);
  return [person.first_name, person.last_name].filter((part) => typeof part === "string" && part).join(" ")
    || (typeof person.username === "string" ? person.username : "-");
}

function recordTable(rows: readonly (readonly [string, unknown])[]): string {
  return renderTable(rows.map(([field, value]) => ({ field, value })), [["field", "Field"], ["value", "Value"]]);
}

function taskTable(value: unknown): string {
  const rows = records(value).map((task) => ({
    task: task.abbreviation,
    name: task.name,
    status: task.status_label ?? task.status,
    due: task.due_date,
    grade: task.grade_label ?? task.grade,
    quality: task.quality_pts,
    overdue: task.is_overdue === true ? "Yes" : "No",
  }));
  return renderTable(rows, [["task", "Task"], ["name", "Name"], ["status", "Status"], ["due", "Due"], ["grade", "Grade"], ["quality", "Quality"], ["overdue", "Overdue"]]);
}

function taskDefinitionTable(value: unknown): string {
  const rows = records(value).map((task) => ({ task: task.abbreviation, name: task.name }));
  return renderTable(rows, [["task", "Task"], ["name", "Name"]]);
}

function terminalText(value: unknown): string {
  if (typeof value !== "string") return "-";
  const text = value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "").replace(/\s+/gu, " ").trim();
  if (!text) return "-";
  const characters = Array.from(text);
  return characters.length <= 120 ? text : `${characters.slice(0, 117).join("")}...`;
}

function formatBytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "-";
  if (value < 1_024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB"];
  let amount = value;
  let unit = "B";
  for (const candidate of units) {
    amount /= 1_024;
    unit = candidate;
    if (amount < 1_024) break;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

function terminal(view: OutputView, value: unknown, emptyMessage?: string): string {
  if (Array.isArray(value) && value.length === 0 && emptyMessage) return `${emptyMessage}\n`;
  if (view === "projects") {
    const rows = records(value).map((project) => {
      const unit = nested(project, "unit");
      return { id: project.id, unit: unit.code, name: unit.name, role: unit.my_role, start: unit.start_date, end: unit.end_date, active: unit.active };
    });
    return renderTable(rows, [["id", "ID"], ["unit", "Unit"], ["name", "Name"], ["role", "Role"], ["start", "Start"], ["end", "End"], ["active", "Active"]]);
  }
  if (view === "tasks") return taskTable(value);
  if (view === "chats-summary") {
    const rows = records(value).map((chat) => ({ task: chat.task, name: chat.name, status: chat.status, unread: chat.unread_comments }));
    return renderTable(rows, [["task", "Task"], ["name", "Name"], ["status", "Status"], ["unread", "Unread"]]);
  }
  if (view === "chats-history") {
    const rows = records(value).map((chat) => ({
      time: chat.created_at,
      author: personName(chat.author),
      type: chat.type,
      message: terminalText(chat.comment),
      attachment: chat.has_attachment === true ? "Yes" : "No",
      reply: chat.reply_to_id,
    }));
    return renderTable(rows, [["time", "Time"], ["author", "Author"], ["type", "Type"], ["message", "Message"], ["attachment", "Attachment"], ["reply", "Reply To"]]);
  }
  if (view === "roles") {
    const rows = records(value).map((role) => {
      const unit = nested(role, "unit");
      return { unit: unit.code, name: unit.name, role: role.role, user: personName(role.user) };
    });
    return renderTable(rows, [["unit", "Unit"], ["name", "Name"], ["role", "Role"], ["user", "User"]]);
  }
  const data = record(value);
  if (view === "project") {
    const project = nested(data, "project");
    const unit = nested(data, "unit");
    const unitSummary = nested(unit, "summary");
    const summary = recordTable([
      ["Project ID", project.id],
      ["Unit", unitSummary.code ?? unit.code ?? nested(project, "unit").code],
      ["Name", unitSummary.name ?? unit.name ?? nested(project, "unit").name],
      ["Target grade", project.target_grade],
      ["Submitted grade", project.submitted_grade],
    ]);
    const tasks = records(data.tasks);
    if (tasks.length) return `${summary}\nTasks\n${taskTable(tasks)}`;
    const definitions = records(unit.task_definitions);
    return `${summary}\nTasks\nNo project tasks found.\n${definitions.length ? `\nAvailable unit tasks\n${taskDefinitionTable(definitions)}` : ""}`;
  }
  if (view === "download") {
    const file = data.file_path;
    const row = {
      project: data.project_id,
      unit: data.unit_id,
      task: data.task,
      file: file ?? data.archive_path,
      size: formatBytes(data.bytes_written),
    };
    return file === undefined
      ? renderTable([{ project: row.project, unit: row.unit, archive: row.file, size: row.size }], [["project", "Project"], ["unit", "Unit"], ["archive", "Archive"], ["size", "Size"]])
      : renderTable([row], [["project", "Project"], ["unit", "Unit"], ["task", "Task"], ["file", "File"], ["size", "Size"]]);
  }
  if (view === "user" || view === "auth-login") {
    return recordTable([
      ["Username", data.username],
      ...(view === "user" ? [["Name", [data.first_name, data.last_name].filter(Boolean).join(" ") || data.nickname], ["Email", data.email], ["Base URL", data.base_url], ["Auth method", data.auth_method]] as const
        : [["Access token expiry", data.auth_token_expiry]] as const),
    ]);
  }
  if (view === "auth-check") {
    return recordTable([["Base URL", data.base_url], ["Username", data.username], ["Auth method", data.auth_method], ["Projects", data.projects], ["Unit roles", data.unit_roles]]);
  }
  return recordTable(Object.entries(data));
}

async function invoke(argv: readonly string[], dependencies: Dependencies): Promise<InvocationResult> {
  const { app } = dependencies;
  const [command, ...rest] = argv;
  const common = { json: { type: "boolean" as const }, help: { type: "boolean" as const } };
  if (command === "user") {
    const parsed = parseArgs({ args: rest, options: common, allowPositionals: false, strict: true });
    return { value: await app.user(), json: parsed.values.json ?? false, view: "user" };
  }
  if (command === "auth" && rest[0] === "check") {
    const parsed = parseArgs({ args: rest.slice(1), options: common, allowPositionals: false, strict: true });
    return { value: await app.authCheck(), json: parsed.values.json ?? false, view: "auth-check" };
  }
  if (command === "auth" && rest[0] === "login") {
    const parsed = parseArgs({ args: rest.slice(1), options: common, allowPositionals: false, strict: true });
    if (!dependencies.authLogin) throw new CliError("config", "Interactive login is unavailable.");
    return { value: await dependencies.authLogin(), json: parsed.values.json ?? false, view: "auth-login" };
  }
  if (command === "projects") {
    const parsed = parseArgs({ args: rest, options: { ...common, "include-inactive": { type: "boolean" } }, allowPositionals: false, strict: true });
    const includeInactive = parsed.values["include-inactive"] ?? false;
    return {
      value: await app.projects({ includeInactive }),
      json: parsed.values.json ?? false,
      view: "projects",
      emptyMessage: includeInactive ? "No projects found." : "No active projects found. Use --include-inactive to include past projects.",
    };
  }
  if (command === "project") {
    const parsed = parseArgs({ args: rest, options: common, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== 1) throw new CliError("usage", "project requires one project_id integer");
    return { value: await app.project(projectId(parsed.positionals[0])), json: parsed.values.json ?? false, view: "project" };
  }
  if (command === "tasks") {
    const parsed = parseArgs({ args: rest, options: { ...common, status: { type: "string", multiple: true } }, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== 1) throw new CliError("usage", "tasks requires one project_id integer");
    const statuses = parsed.values.status ?? [];
    return {
      value: await app.tasks(projectId(parsed.positionals[0]), { statuses }),
      json: parsed.values.json ?? false,
      view: "tasks",
      emptyMessage: statuses.length ? `No tasks match status: ${statuses.join(", ")}.` : "No tasks found.",
    };
  }
  if (command === "resources" && rest[0] === "download") {
    const parsed = parseArgs({
      args: rest.slice(1),
      options: { ...common, output: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length !== 1) throw new CliError("usage", "resources download requires one project_id integer");
    if (parsed.values.output !== undefined && !parsed.values.output.trim()) throw new CliError("usage", "output path must not be empty");
    return {
      value: await app.resourcesDownload(
        projectId(parsed.positionals[0]),
        parsed.values.output === undefined ? {} : { output: parsed.values.output },
      ),
      json: parsed.values.json ?? false,
      view: "download",
    };
  }
  if (command === "task" && (rest[0] === "sheet" || rest[0] === "resources")) {
    const kind = rest[0];
    const parsed = parseArgs({
      args: rest.slice(1),
      options: { ...common, output: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length !== 2) throw new CliError("usage", `task ${kind} requires a project_id and task abbreviation`);
    const task = parsed.positionals[1]?.trim();
    if (!task) throw new CliError("usage", "task abbreviation must not be empty");
    if (parsed.values.output !== undefined && !parsed.values.output.trim()) throw new CliError("usage", "output path must not be empty");
    const options = parsed.values.output === undefined ? {} : { output: parsed.values.output };
    return {
      value: kind === "sheet"
        ? await app.taskSheetDownload(projectId(parsed.positionals[0]), task, options)
        : await app.taskResourcesDownload(projectId(parsed.positionals[0]), task, options),
      json: parsed.values.json ?? false,
      view: "download",
    };
  }
  if (command === "chats") {
    const parsed = parseArgs({ args: rest, options: common, allowPositionals: true, strict: true });
    if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
      throw new CliError("usage", "chats requires a project_id and accepts one optional task abbreviation");
    }
    const task = parsed.positionals[1]?.trim();
    if (parsed.positionals.length === 2 && !task) throw new CliError("usage", "task abbreviation must not be empty");
    const diagnostic = "Note: Viewing task chat marks its non-discussion comments as read in OnTrack.\n";
    if (task) dependencies.onDiagnostic?.(diagnostic);
    return {
      value: await app.chats(projectId(parsed.positionals[0]), task ? { task } : {}),
      json: parsed.values.json ?? false,
      view: task ? "chats-history" : "chats-summary",
      emptyMessage: task ? "No chat messages found." : "No project tasks found.",
      ...(task && !dependencies.onDiagnostic ? { diagnostic } : {}),
    };
  }
  if (command === "roles") {
    const parsed = parseArgs({ args: rest, options: { ...common, all: { type: "boolean" } }, allowPositionals: false, strict: true });
    const showAll = parsed.values.all ?? false;
    return {
      value: await app.roles({ showAll }),
      json: parsed.values.json ?? false,
      view: "roles",
      emptyMessage: showAll ? "No teaching roles found." : "No active teaching roles found. Use --all to include inactive roles.",
    };
  }
  throw new CliError("usage", command ? `Unknown command: ${command}` : "A command is required");
}

export async function executeCli(argv: readonly string[], dependencies: Dependencies): Promise<CliExecution> {
  const sensitiveValues = dependencies.sensitiveValues ?? [];
  if (argv.length === 0) return { exitCode: 0, stdout: rootHelp(), stderr: "" };
  if (argv.length === 1 && argv[0] === "--help") return { exitCode: 0, stdout: rootHelp(), stderr: "" };
  if (argv.length === 1 && argv[0] === "--version") return { exitCode: 0, stdout: `ontrack ${dependencies.version}\n`, stderr: "" };
  if ((argv.length === 1 && (argv[0] === "auth" || argv[0] === "resources" || argv[0] === "task")) || argv.includes("--help")) {
    const help = helpFor(argv);
    if (help) return { exitCode: 0, stdout: help, stderr: "" };
  }
  try {
    const result = await invoke(argv, dependencies);
    const value = sanitized(result.value);
    const stdout = result.json ? renderJson(value) : terminal(result.view, value, result.emptyMessage);
    return {
      exitCode: 0,
      stdout: redact(stdout, sensitiveValues),
      stderr: redact(result.diagnostic ?? "", sensitiveValues),
    };
  } catch (error) {
    const cliError = error instanceof CliError
      ? error
      : error instanceof TypeError
        ? new CliError("usage", error.message)
        : new CliError("upstream_api", error instanceof Error ? error.message : String(error));
    const label = cliError.category.replaceAll("_", " ");
    return {
      exitCode: exitCodeFor(cliError.category),
      stdout: "",
      stderr: redact(`${label} error: ${cliError.message}\n`, sensitiveValues),
    };
  }
}
