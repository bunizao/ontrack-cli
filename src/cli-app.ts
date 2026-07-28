import { parseArgs } from "node:util";

import { CliError, exitCodeFor } from "./errors.js";
import { renderJson, renderTable } from "./render.js";
import { submissionType, type TaskSubmissionOptions, type TaskSubmissionPlan } from "./submission.js";

export interface CliApplication {
  resolveProject(reference: string): Promise<number>;
  user(): Promise<unknown>;
  authCheck(): Promise<unknown>;
  projects(options: { readonly includeInactive: boolean }): Promise<unknown>;
  project(projectId: number): Promise<unknown>;
  tasks(projectId: number, options: { readonly statuses: readonly string[] }): Promise<unknown>;
  resourcesDownload(projectId: number, options: { readonly output?: string }): Promise<unknown>;
  taskSheetDownload(projectId: number, task: string, options: { readonly output?: string }): Promise<unknown>;
  taskResourcesDownload(projectId: number, task: string, options: { readonly output?: string }): Promise<unknown>;
  taskRead(projectId: number, task: string): Promise<unknown>;
  taskState(projectId: number, task: string, state: string): Promise<unknown>;
  prepareTaskSubmission(projectId: number, task: string, options: TaskSubmissionOptions): Promise<TaskSubmissionPlan>;
  submitTask(plan: TaskSubmissionPlan): Promise<unknown>;
  chats(projectId: number, options: { readonly task?: string }): Promise<unknown>;
  prepareChatSend(projectId: number, task: string, message: string): Promise<ChatSendConfirmation>;
  chatSend(plan: ChatSendConfirmation): Promise<unknown>;
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
  readonly confirmChatSend?: (details: ChatSendConfirmation) => Promise<boolean>;
  readonly confirmTaskSubmit?: (plan: TaskSubmissionPlan) => Promise<boolean>;
  readonly interactive?: boolean;
}

export interface ChatSendConfirmation {
  readonly projectId: number;
  readonly taskDefinitionId: number;
  readonly task: string;
  readonly message: string;
}

type OutputView = "auth-check" | "auth-login" | "chat-send" | "chats-history" | "chats-summary" | "download" | "markdown" | "project" | "projects" | "roles" | "submission" | "task-state" | "tasks" | "user";

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
    "  project <project>    Show one project",
    "  tasks <project>      List project tasks",
    "  resources download <project> Download project resources",
    "  task sheet <project> <task> Download one task sheet",
    "  task resources <project> <task> Download one task's resources",
    "  task read <project> <task> Print one task sheet as Markdown",
    "  task state <project> <task> <state> Change one task's workflow state",
    "  task submit <project> <task> Submit task files for feedback",
    "  chats <project> [task] Show unread chat counts or one task's history",
    "  chats send <project> <task> Send one text chat message",
    "  roles                List teaching roles",
    "",
    "Project arguments accept a unique unit code such as FIT1045 or the ID from `ontrack projects`.",
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
    return "Usage: ontrack resources <command>\n\nCommands:\n  download <project> Download all task sheets and resources\n";
  }
  if (args.length === 1 && args[0] === "task") {
    return "Usage: ontrack task <command>\n\nCommands:\n  sheet <project> <task>         Download one task sheet\n  resources <project> <task>     Download one task's resources\n  read <project> <task>          Print one task sheet as Markdown\n  state <project> <task> <state> Change one task's workflow state\n  submit <project> <task>        Submit task files\n";
  }
  if (args[0] === "user") return commandHelp("ontrack user", "Show the resolved signed-in user.", []);
  if (key === "auth check") return commandHelp("ontrack auth check", "Validate current credentials.", []);
  if (key === "auth login") return commandHelp("ontrack auth login", "Reuse browser cookies or open the OnTrack SAML sign-in URL.", []);
  if (args[0] === "projects") return commandHelp("ontrack projects", "List projects available to the signed-in user.", ["  --include-inactive   Include past projects"]);
  if (args[0] === "project") return commandHelp(
    "ontrack project <project>",
    "Show a project and its task snapshot.",
    [],
    "Use a unique unit code or the ID shown by `ontrack projects --include-inactive`; list positions are not accepted.",
  );
  if (args[0] === "tasks") return commandHelp(
    "ontrack tasks <project>",
    "List project tasks.",
    ["  --status <status>    Match a raw task status; repeat to match more than one"],
    "Use a unique unit code or a project ID; list positions are not accepted.",
  );
  if (key === "resources download") return commandHelp(
    "ontrack resources download <project>",
    "Download all task sheets and resources for the project's unit.",
    ["  --output <path>      Destination ZIP; defaults to ontrack-resources-<project_id>.zip"],
    "Existing files are never replaced. Project IDs are not list positions.",
  );
  if (key === "task sheet") return commandHelp(
    "ontrack task sheet <project> <task>",
    "Download one task sheet by an abbreviation shown in `ontrack project`.",
    ["  --output <path>      Destination PDF; defaults to <unit>-<task>.pdf"],
    "A numeric task-definition ID is accepted as a fallback. Existing files are never replaced.",
  );
  if (key === "task resources") return commandHelp(
    "ontrack task resources <project> <task>",
    "Download one task's linked file or resource ZIP using an abbreviation shown in `ontrack project`.",
    ["  --output <path>      Destination path; defaults to the server filename"],
    "A numeric task-definition ID is accepted as a fallback. Existing files are never replaced.",
  );
  if (key === "task read") return commandHelp(
    "ontrack task read <project> <task>",
    "Download a task sheet in memory and print built-in PDF-to-Markdown output.",
    [],
    "No PDF file or external pdftotext command is required.",
  );
  if (key === "task state") return commandHelp(
    "ontrack task state <project> <task> <state>",
    "Change one assigned task's workflow state.",
    [],
    "Student states are not_started, working_on_it, and need_help. This does not submit files.",
  );
  if (key === "task submit") return commandHelp(
    "ontrack task submit <project> <task>",
    "Submit files for one assigned task.",
    [
      "  --file <path>       File in upload-requirement order; repeat for each file",
      "  --type <type>       ready_for_feedback (default), need_help, or assess_in_portfolio",
      "  --comment <text>    Optional submission comment",
      "  --accept-tii-eula   Confirm acceptance of the Turnitin EULA for this submission",
      "  -y, --yes            Confirm without an interactive prompt",
    ],
    "This changes OnTrack. Accepted files are processed asynchronously.",
  );
  if (key === "chats send") return commandHelp(
    "ontrack chats send <project> <task>",
    "Send one text message to a task chat.",
    ["  --message <text>     Exact message to send", "  -y, --yes            Confirm without an interactive prompt"],
    "This changes OnTrack. Agents must use it only after the user confirms the exact project, task, and message.",
  );
  if (args[0] === "chats") return commandHelp(
    "ontrack chats <project> [task]",
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

async function resolvedProjectId(value: string | undefined, app: CliApplication): Promise<number> {
  if (!value?.trim()) throw new CliError("usage", "project must be a project ID or unit code");
  const reference = value.trim();
  if (/^\d+$/u.test(reference)) return projectId(reference);
  if (/^[a-z]{2,}\d{3,}[a-z0-9_-]*$/iu.test(reference)) return app.resolveProject(reference);
  throw new CliError("usage", "project_id must be an integer or a unit code such as FIT1045");
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
  if (view === "chat-send") {
    const data = record(value);
    return renderTable([{
      project: data.project_id,
      task: data.task,
      comment: data.comment_id,
      time: data.created_at,
      message: terminalText(data.message),
    }], [["project", "Project"], ["task", "Task"], ["comment", "Comment ID"], ["time", "Time"], ["message", "Message"]]);
  }
  if (view === "submission") {
    const data = record(value);
    return recordTable([
      ["Project", data.project_id],
      ["Task", data.task],
      ["Submission type", data.submission_type],
      ["Status", data.status],
      ["Processing asynchronously", data.processing_async === true ? "Yes" : "No"],
    ]);
  }
  if (view === "roles") {
    const rows = records(value).map((role) => {
      const unit = nested(role, "unit");
      return { unit: unit.code, name: unit.name, role: role.role, user: personName(role.user) };
    });
    return renderTable(rows, [["unit", "Unit"], ["name", "Name"], ["role", "Role"], ["user", "User"]]);
  }
  const data = record(value);
  if (view === "markdown") return typeof data.markdown === "string" ? data.markdown : "";
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
    if (parsed.positionals.length !== 1) throw new CliError("usage", "project requires one project ID or unit code");
    return { value: await app.project(await resolvedProjectId(parsed.positionals[0], app)), json: parsed.values.json ?? false, view: "project" };
  }
  if (command === "tasks") {
    const parsed = parseArgs({ args: rest, options: { ...common, status: { type: "string", multiple: true } }, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== 1) throw new CliError("usage", "tasks requires one project ID or unit code");
    const statuses = parsed.values.status ?? [];
    return {
      value: await app.tasks(await resolvedProjectId(parsed.positionals[0], app), { statuses }),
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
    if (parsed.positionals.length !== 1) throw new CliError("usage", "resources download requires one project ID or unit code");
    if (parsed.values.output !== undefined && !parsed.values.output.trim()) throw new CliError("usage", "output path must not be empty");
    return {
      value: await app.resourcesDownload(
        await resolvedProjectId(parsed.positionals[0], app),
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
    if (parsed.positionals.length !== 2) throw new CliError("usage", `task ${kind} requires a project and task abbreviation`);
    const task = parsed.positionals[1]?.trim();
    if (!task) throw new CliError("usage", "task abbreviation must not be empty");
    if (parsed.values.output !== undefined && !parsed.values.output.trim()) throw new CliError("usage", "output path must not be empty");
    const options = parsed.values.output === undefined ? {} : { output: parsed.values.output };
    return {
      value: kind === "sheet"
        ? await app.taskSheetDownload(await resolvedProjectId(parsed.positionals[0], app), task, options)
        : await app.taskResourcesDownload(await resolvedProjectId(parsed.positionals[0], app), task, options),
      json: parsed.values.json ?? false,
      view: "download",
    };
  }
  if (command === "task" && rest[0] === "read") {
    const parsed = parseArgs({ args: rest.slice(1), options: common, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== 2) throw new CliError("usage", "task read requires a project and task abbreviation");
    const task = parsed.positionals[1]?.trim();
    if (!task) throw new CliError("usage", "task abbreviation must not be empty");
    return {
      value: await app.taskRead(await resolvedProjectId(parsed.positionals[0], app), task),
      json: parsed.values.json ?? false,
      view: "markdown",
    };
  }
  if (command === "task" && rest[0] === "state") {
    const parsed = parseArgs({ args: rest.slice(1), options: common, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== 3) throw new CliError("usage", "task state requires a project, task, and state");
    const task = parsed.positionals[1]?.trim();
    const state = parsed.positionals[2]?.trim();
    if (!task) throw new CliError("usage", "task abbreviation must not be empty");
    if (!state) throw new CliError("usage", "task state must not be empty");
    return {
      value: await app.taskState(await resolvedProjectId(parsed.positionals[0], app), task, state),
      json: parsed.values.json ?? false,
      view: "task-state",
    };
  }
  if (command === "task" && rest[0] === "submit") {
    const parsed = parseArgs({
      args: rest.slice(1),
      options: {
        ...common,
        file: { type: "string", multiple: true },
        type: { type: "string" },
        comment: { type: "string" },
        "accept-tii-eula": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length !== 2) throw new CliError("usage", "task submit requires a project and task abbreviation");
    const task = parsed.positionals[1]?.trim();
    if (!task) throw new CliError("usage", "task abbreviation must not be empty");
    const files = parsed.values.file ?? [];
    if (files.length === 0 || files.some((file) => !file.trim())) throw new CliError("usage", "task submit requires at least one non-empty --file path");
    const type = submissionType(parsed.values.type?.trim() || "ready_for_feedback");
    const comment = parsed.values.comment;
    if (comment !== undefined && !comment.trim()) throw new CliError("usage", "submission comment must not be empty");
    if (comment !== undefined && Array.from(comment).length > 4_095) throw new CliError("usage", "submission comment must not exceed 4095 characters");
    const confirmTaskSubmit = dependencies.confirmTaskSubmit;
    if (!parsed.values.yes && (!confirmTaskSubmit || dependencies.interactive === false)) {
      throw new CliError("usage", "Task submission requires confirmation in an interactive terminal or --yes after the user confirms the exact project, task, file list, and submission type.");
    }
    const projectId = await resolvedProjectId(parsed.positionals[0], app);
    const baseOptions = { files, type, acceptTiiEula: parsed.values["accept-tii-eula"] ?? false };
    const options = comment === undefined ? baseOptions : { ...baseOptions, comment };
    const plan = await app.prepareTaskSubmission(projectId, task, options);
    if (!parsed.values.yes && confirmTaskSubmit && !await confirmTaskSubmit(plan)) {
      throw new CliError("usage", "Task submission was not confirmed.");
    }
    return {
      value: await app.submitTask(plan),
      json: parsed.values.json ?? false,
      view: "submission",
    };
  }
  if (command === "chats" && rest[0] === "send") {
    const parsed = parseArgs({
      args: rest.slice(1),
      options: {
        ...common,
        message: { type: "string" },
        yes: { type: "boolean", short: "y" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length !== 2) throw new CliError("usage", "chats send requires a project and task abbreviation");
    const task = parsed.positionals[1]?.trim();
    if (!task) throw new CliError("usage", "task abbreviation must not be empty");
    const rawMessage = parsed.values.message;
    if (rawMessage === undefined) throw new CliError("usage", "chats send requires --message <text>");
    const message = rawMessage.trim();
    if (!message) throw new CliError("usage", "chat message must not be empty");
    if (Array.from(message).length > 4_095) throw new CliError("usage", "chat message must not exceed 4095 characters");
    const confirmChatSend = dependencies.confirmChatSend;
    if (!parsed.values.yes && (!confirmChatSend || dependencies.interactive === false)) {
      throw new CliError("usage", "Chat sending requires confirmation in an interactive terminal or --yes after the user confirms the exact project, task, and message.");
    }
    const id = await resolvedProjectId(parsed.positionals[0], app);
    const plan = await app.prepareChatSend(id, task, message);
    if (!parsed.values.yes && confirmChatSend) {
      const confirmed = await confirmChatSend(plan);
      if (!confirmed) throw new CliError("usage", "Chat message was not confirmed.");
    }
    return {
      value: await app.chatSend(plan),
      json: parsed.values.json ?? false,
      view: "chat-send",
    };
  }
  if (command === "chats") {
    const parsed = parseArgs({ args: rest, options: common, allowPositionals: true, strict: true });
    if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
      throw new CliError("usage", "chats requires a project and accepts one optional task abbreviation");
    }
    const task = parsed.positionals[1]?.trim();
    if (parsed.positionals.length === 2 && !task) throw new CliError("usage", "task abbreviation must not be empty");
    const diagnostic = "Note: Viewing task chat marks its non-discussion comments as read in OnTrack.\n";
    if (task) dependencies.onDiagnostic?.(diagnostic);
    return {
      value: await app.chats(await resolvedProjectId(parsed.positionals[0], app), task ? { task } : {}),
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
