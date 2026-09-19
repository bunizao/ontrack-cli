import {
  CliError as ContractError,
  commandsJson,
  createProgram,
  createUi,
  examples,
  helpSection,
  insertDefaultVerb,
  isInformationalExit,
  mutating,
  parseWithPrompts,
  render,
  reportError,
  resolveFormat,
  type ArgumentFiller,
  type NounSpec,
  type OutputFormat,
  type Ui,
} from "@bunizao/cli-kit";

import { CliError } from "./errors.js";
import { assertSupportedRuntime } from "./runtime.js";
import { renderSkill } from "./skill.js";
import { submissionType, submissionTypes, type TaskSubmissionOptions, type TaskSubmissionPlan } from "./submission.js";
import { writableTaskState, writableTaskStates, type WritableTaskState } from "./status.js";

export interface CliApplication {
  resolveProject(reference: string): Promise<number>;
  user(): Promise<unknown>;
  authCheck(): Promise<unknown>;
  projects(options: { readonly includeInactive: boolean }): Promise<unknown>;
  project(projectId: number): Promise<unknown>;
  tasks(projectId: number, options: { readonly statuses: readonly string[] }): Promise<unknown>;
  taskShow(projectId: number, task: string): Promise<unknown>;
  resourcesDownload(projectId: number, options: DownloadOptions): Promise<unknown>;
  taskSheetDownload(projectId: number, task: string, options: DownloadOptions): Promise<unknown>;
  taskResourcesDownload(projectId: number, task: string, options: DownloadOptions): Promise<unknown>;
  taskRead(projectId: number, task: string): Promise<unknown>;
  taskState(projectId: number, task: string, state: WritableTaskState): Promise<unknown>;
  prepareTaskSubmission(projectId: number, task: string, options: TaskSubmissionOptions): Promise<TaskSubmissionPlan>;
  submitTask(plan: TaskSubmissionPlan): Promise<unknown>;
  chats(projectId: number, options: { readonly task?: string }): Promise<unknown>;
  chatMarkRead(projectId: number, task: string): Promise<unknown>;
  prepareChatSend(projectId: number, task: string, message: string): Promise<ChatSendConfirmation>;
  chatSend(plan: ChatSendConfirmation): Promise<unknown>;
  roles(options: { readonly showAll: boolean }): Promise<unknown>;
}

interface DownloadOptions {
  readonly output?: string;
  readonly force?: boolean;
}

export interface CliExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output?: string;
}

interface Dependencies {
  readonly application: () => Promise<CliApplication>;
  readonly authLogin?: () => Promise<unknown>;
  readonly authLogout?: () => Promise<unknown>;
  readonly version: string;
  readonly sensitiveValues?: readonly string[];
  readonly onDiagnostic?: (message: string) => void;
  readonly confirmChatSend?: (details: ChatSendConfirmation) => Promise<boolean>;
  readonly confirmTaskSubmit?: (plan: TaskSubmissionPlan) => Promise<boolean>;
  readonly confirmMutation?: (summary: string) => Promise<boolean>;
  readonly interactive?: boolean;
  /** Prompts for what a person left out; omitted means never prompt. */
  readonly ui?: Ui;
  readonly stdoutIsTty?: boolean;
  /** Terminal width tables have to fit into. Omitted means unlimited. */
  readonly stdoutColumns?: number;
  readonly runtime?: { readonly nodeVersion: string; readonly bunVersion?: string };
}

/**
 * What a person wants to see per row. Every field stays in --json; a table that
 * carries two dozen columns has to shave them all down to nothing to fit a
 * terminal, so the human format picks the few that identify the row.
 */
const TABLE_COLUMNS: Readonly<Record<string, readonly [string, string][]>> = {
  "units list": [["id", "project"], ["unit.code", "code"], ["unit.name", "name"], ["target_grade", "target"]],
  "tasks list": [["abbreviation", "task"], ["name", "name"], ["status_label", "status"], ["deadline", "due"], ["grade_label", "grade"]],
  "roles list": [["id", "id"], ["role", "role"], ["unit.code", "code"], ["unit.name", "name"]],
  "chats list": [["id", "id"], ["abbreviation", "task"], ["name", "name"], ["status_label", "status"]],
};

function commandPath(command: { name(): string; parent?: unknown }): string {
  const names: string[] = [];
  for (let current = command; current?.parent; current = current.parent as typeof command) {
    names.unshift(current.name());
  }
  return names.join(" ");
}

export interface ChatSendConfirmation {
  readonly projectId: number;
  readonly taskDefinitionId: number;
  readonly task: string;
  readonly message: string;
}

interface InvocationResult {
  readonly value?: unknown;
  readonly markdown?: string;
  readonly diagnostic?: string;
  readonly dryRun?: string;
}

interface GlobalOptions {
  readonly json?: boolean;
  readonly yaml?: boolean;
  readonly table?: boolean;
  readonly fields?: string;
  readonly output?: string;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
}

const taskNounSpec: NounSpec = {
  name: "tasks",
  verbs: ["list", "show", "read", "get", "set", "submit"],
  valueFlags: ["--status"],
  defaultByArity: { 0: "list", 1: "list", 2: "show" },
};

export const nounSpecs: readonly NounSpec[] = [
  { name: "units", aliases: ["courses", "projects"], verbs: ["list", "show", "get"], defaultByArity: { 0: "list", 1: "show" } },
  taskNounSpec,
  { name: "chats", verbs: ["list", "read", "send", "mark-read"], defaultByArity: { 0: "list", 1: "list", 2: "read" } },
  { name: "roles", verbs: ["list"], defaultByArity: { 0: "list" } },
];

// The same two positionals recur across the tree; described once, they show in help,
// in the usage hint an agent gets, and as the prompt a person sees when one is missing.
const ARGUMENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  unit: "Unit code, name or project id",
  task: "Task abbreviation, such as 1.1",
};

function describeArguments(command: ReturnType<typeof createProgram>): void {
  for (const argument of command.registeredArguments) {
    if (!argument.description) argument.description = ARGUMENT_DESCRIPTIONS[argument.name()] ?? "";
  }
  for (const child of command.commands) describeArguments(child);
}

const HELP_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  Reading: ["user", "units", "tasks", "chats", "roles"],
  Setup: ["auth", "commands", "skills"],
};

// A person who typed `ontrack tasks` is shown their units, then the unit's tasks.
function argumentFillers(application: () => Promise<CliApplication>, ui: Ui): Record<string, ArgumentFiller> {
  return {
    unit: async () => {
      const projects = await (await application()).projects({ includeInactive: false }) as readonly { id: number; unit: { code: string; name: string } }[];
      return ui.select("Which unit?", projects.map((project) => ({ value: String(project.id), label: project.unit.name, hint: project.unit.code })));
    },
    task: async ({ provided }) => {
      const projectId = await resolvedProjectId(provided.unit ?? "", application);
      const tasks = await (await application()).tasks(projectId, { statuses: [] }) as readonly { abbreviation: string; name: string; status_label: string }[];
      return ui.select("Which task?", tasks.map((task) => ({ value: task.abbreviation, label: `${task.abbreviation} ${task.name}`, hint: task.status_label })));
    },
  };
}

const secretKeys = new Set([
  "authentication_token", "auth_token", "access_token", "refresh_token",
  "authenticationToken", "authToken", "accessToken", "refreshToken",
]);

function normalizedArgv(argv: readonly string[]): string[] {
  const result = insertDefaultVerb(argv, nounSpecs);
  if (result.length !== argv.length + 1) return result;
  const nounIndex = result.findIndex((token, index) => token === "tasks" && result[index + 1] === "show");
  if (nounIndex === -1) return result;
  const commandArguments = result.slice(nounIndex + 2);
  const terminator = commandArguments.indexOf("--");
  const options = terminator === -1 ? commandArguments : commandArguments.slice(0, terminator);
  if (options.includes("--status")) {
    result[nounIndex + 1] = "list";
  }
  return result;
}

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

function positiveId(value: string): number {
  if (!/^\d+$/u.test(value)) throw new CliError("usage", "unit must be a project ID or unit code");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new CliError("usage", "project ID must be a positive safe integer");
  return id;
}

// A unit reference is a project ID or anything the site's unit list can match
// (code or name). No code format is assumed here; resolution compares against
// the enrolled units.
async function resolvedProjectId(value: string, application: () => Promise<CliApplication>): Promise<number> {
  const reference = value.trim();
  if (/^\d+$/u.test(reference)) return positiveId(reference);
  if (reference) return (await application()).resolveProject(reference);
  throw new CliError("usage", "unit must be a project ID or a unit code or name as shown by `ontrack units`");
}

function nonEmpty(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new CliError("usage", `${label} must not be empty`);
  return result;
}

function downloadOptions(options: { readonly dest?: string; readonly force?: boolean }): DownloadOptions {
  const dest = options.dest === undefined ? undefined : nonEmpty(options.dest, "destination path");
  return { ...(dest ? { output: dest } : {}), ...(options.force ? { force: true } : {}) };
}

function selectedFormat(argv: readonly string[], isTty: boolean): OutputFormat {
  return resolveFormat({
    json: argv.includes("--json"),
    yaml: argv.includes("--yaml"),
    table: argv.includes("--table"),
  }, isTty);
}

function sharedError(error: unknown): unknown {
  if (!(error instanceof CliError)) return error;
  const code = error.category === "cancellation" ? "cancelled"
    : error.category === "upstream_contract" || error.category === "upstream_api" ? "upstream"
      : error.category;
  return new ContractError(code, error.message, error.hint);
}

async function requireConfirmation(
  summary: string,
  options: GlobalOptions,
  dependencies: Dependencies,
  specific?: () => Promise<boolean>,
): Promise<InvocationResult | undefined> {
  if (options.dryRun) return { dryRun: summary };
  if (options.yes) return undefined;
  if (dependencies.interactive === false || (!specific && !dependencies.confirmMutation)) {
    throw new CliError("usage", "Mutation requires --yes when stdin is not interactive.");
  }
  const confirmed = specific ? await specific() : await dependencies.confirmMutation!(summary);
  if (!confirmed) throw new CliError("cancellation", "Mutation cancelled.");
  return undefined;
}

function fields(options: GlobalOptions): readonly string[] | undefined {
  if (options.fields === undefined) return undefined;
  const values = options.fields.split(",").map((field) => field.trim()).filter(Boolean);
  if (values.length === 0) throw new CliError("usage", "--fields requires at least one field");
  return values;
}

export async function executeCli(argv: readonly string[], dependencies: Dependencies): Promise<CliExecution> {
  const sensitiveValues = dependencies.sensitiveValues ?? [];
  let stdout = "";
  let stderr = "";
  let result: InvocationResult | undefined;
  let format: OutputFormat;
  let ranCommand = "";
  try {
    if (dependencies.runtime) assertSupportedRuntime(dependencies.runtime.nodeVersion, dependencies.runtime.bunVersion);
    format = selectedFormat(argv, dependencies.stdoutIsTty ?? false);
  } catch (error) {
    const reported = reportError(sharedError(error), "table");
    return { exitCode: reported.exitCode, stdout: "", stderr: redact(reported.text, sensitiveValues) };
  }

  const application = dependencies.application;
  const setResult = (value: InvocationResult): void => { result = value; };
  let current: ReturnType<typeof createProgram> | undefined;
  const globalOptions = (): GlobalOptions => (current ?? build()).opts<GlobalOptions>();
  // Commander programs parse once, so a prompt round rebuilds the tree from scratch.
  const build = (): ReturnType<typeof createProgram> => {
    const program = createProgram({
      name: "ontrack",
      version: dependencies.version,
      description: "Terminal-first CLI for OnTrack and Doubtfire",
    });
    program.configureOutput({
      writeOut: (text) => { stdout += text; },
      writeErr: (text) => { stderr += text; },
      outputError: () => undefined,
    });
    program.hook("preAction", (_program, action) => { ranCommand = commandPath(action); });

    program.command("user").description("Show the signed-in user").action(async () => {
      setResult({ value: await (await application()).user() });
    });

    const auth = program.command("auth").description("Manage authentication");
    auth.command("login").description("Sign in through OnTrack").action(async () => {
      if (!dependencies.authLogin) throw new CliError("config", "Interactive login is unavailable.");
      setResult({ value: await dependencies.authLogin() });
    });
    auth.command("status").description("Validate current credentials").action(async () => {
      setResult({ value: await (await application()).authCheck() });
    });
    auth.command("logout").description("Remove the cached session").action(async () => {
      if (!dependencies.authLogout) throw new CliError("config", "Logout is unavailable.");
      setResult({ value: await dependencies.authLogout() });
    });

    const units = program.command("units").aliases(["courses", "projects"]).description("OnTrack enrolments");
    units.command("list").description("List units").option("--include-inactive", "Include past units").action(async (options) => {
      setResult({ value: await (await application()).projects({ includeInactive: options.includeInactive === true }) });
    });
    units.command("show <unit>").description("Show one unit").action(async (unit) => {
      setResult({ value: await (await application()).project(await resolvedProjectId(unit, application)) });
    });
    units.command("get <unit>").description("Download unit resources")
      .option("--dest <path>", "Destination ZIP")
      .option("--force", "Replace an existing destination")
      .action(async (unit, options) => {
        setResult({ value: await (await application()).resourcesDownload(await resolvedProjectId(unit, application), downloadOptions(options)) });
      });

    const tasks = program.command("tasks").description("OnTrack tasks");
    tasks.command("list <unit>").description("List tasks")
      .option("--status <status...>", "Filter by raw task status")
      .action(async (unit, options) => {
        setResult({ value: await (await application()).tasks(await resolvedProjectId(unit, application), { statuses: options.status ?? [] }) });
      });
    tasks.command("show <unit> <task>").description("Show one task").action(async (unit, task) => {
      setResult({ value: await (await application()).taskShow(await resolvedProjectId(unit, application), nonEmpty(task, "task")) });
    });
    tasks.command("read <unit> <task>").description("Print a task sheet as Markdown").action(async (unit, task) => {
      const value = await (await application()).taskRead(await resolvedProjectId(unit, application), nonEmpty(task, "task"));
      const markdown = typeof value === "object" && value !== null && "markdown" in value
        ? String((value as { readonly markdown: unknown }).markdown)
        : String(value);
      setResult({ markdown });
    });
    tasks.command("get <unit> <task>").description("Download a task sheet or resources")
      .option("--resources", "Download linked task resources")
      .option("--dest <path>", "Destination path")
      .option("--force", "Replace an existing destination")
      .action(async (unit, task, options) => {
        const projectId = await resolvedProjectId(unit, application);
        const reference = nonEmpty(task, "task");
        const app = await application();
        const value = options.resources
          ? await app.taskResourcesDownload(projectId, reference, downloadOptions(options))
          : await app.taskSheetDownload(projectId, reference, downloadOptions(options));
        setResult({ value });
      });
    const setTask = tasks.command("set <unit> <task>").description("Change task workflow state")
      .addArgument(tasks.createArgument("<state>", "Workflow state").choices(writableTaskStates));
    mutating(setTask.action(async (unit, task, state) => {
      const parsedState = writableTaskState(state);
      const summary = `Set task ${task} in ${unit} to ${parsedState}.`;
      const confirmation = await requireConfirmation(summary, globalOptions(), dependencies);
      if (confirmation) return setResult(confirmation);
      setResult({ value: await (await application()).taskState(await resolvedProjectId(unit, application), nonEmpty(task, "task"), parsedState) });
    }));
    mutating(tasks.command("submit <unit> <task>").description("Submit task files")
      .requiredOption("--file <path...>", "Files in upload-requirement order")
      .addOption(tasks.createOption("--type <type>", "Submission type").choices(submissionTypes).default("ready_for_feedback"))
      .option("--comment <text>", "Submission comment")
      .option("--accept-tii-eula", "Accept the Turnitin EULA")
      .action(async (unit, task, options) => {
        const files = (options.file as string[]).map((file) => nonEmpty(file, "file path"));
        const type = submissionType(nonEmpty(options.type, "submission type"));
        const comment = options.comment === undefined ? undefined : nonEmpty(options.comment, "submission comment");
        if (comment && Array.from(comment).length > 4_095) throw new CliError("usage", "submission comment must not exceed 4095 characters");
        const summary = `Submit ${files.length} file(s) for task ${task} in ${unit} as ${type}.`;
        if (globalOptions().dryRun) return setResult({ dryRun: summary });
        if (!globalOptions().yes && dependencies.interactive === false) throw new CliError("usage", "Mutation requires --yes when stdin is not interactive.");
        const projectId = await resolvedProjectId(unit, application);
        const base = { files, type, acceptTiiEula: options.acceptTiiEula === true };
        const plan = await (await application()).prepareTaskSubmission(projectId, nonEmpty(task, "task"), comment ? { ...base, comment } : base);
        const confirmation = await requireConfirmation(summary, globalOptions(), dependencies, dependencies.confirmTaskSubmit ? () => dependencies.confirmTaskSubmit!(plan) : undefined);
        if (confirmation) return setResult(confirmation);
        setResult({ value: await (await application()).submitTask(plan) });
      }));

    const chats = program.command("chats").description("Task chats");
    chats.command("list <unit>").description("List unread chat counts").action(async (unit) => {
      setResult({ value: await (await application()).chats(await resolvedProjectId(unit, application), {}) });
    });
    mutating(chats.command("read <unit> <task>").description("Read task chat history and mark comments read").action(async (unit, task) => {
      const summary = `Read chat history for task ${task} in ${unit}; OnTrack will mark non-discussion comments read.`;
      if (globalOptions().dryRun) return setResult({ dryRun: summary });
      if (!globalOptions().yes) {
        throw new CliError(
          "usage",
          "Reading OnTrack chat history marks non-discussion comments read.",
          undefined,
          "Re-run with --yes after acknowledging this side effect.",
        );
      }
      const diagnostic = "warning: Reading OnTrack chat history marks non-discussion comments read.\n";
      dependencies.onDiagnostic?.(diagnostic);
      setResult({
        value: await (await application()).chats(await resolvedProjectId(unit, application), { task: nonEmpty(task, "task") }),
        ...(!dependencies.onDiagnostic ? { diagnostic } : {}),
      });
    }));
    mutating(chats.command("mark-read <unit> <task>").description("Mark task chat comments read").action(async (unit, task) => {
      const summary = `Mark chat comments read for task ${task} in ${unit}.`;
      const confirmation = await requireConfirmation(summary, globalOptions(), dependencies);
      if (confirmation) return setResult(confirmation);
      setResult({ value: await (await application()).chatMarkRead(await resolvedProjectId(unit, application), nonEmpty(task, "task")) });
    }));
    mutating(chats.command("send <unit> <task>").description("Send a task chat message")
      .requiredOption("--message <text>", "Exact message to send")
      .action(async (unit, task, options) => {
        const message = nonEmpty(options.message, "chat message");
        if (Array.from(message).length > 4_095) throw new CliError("usage", "chat message must not exceed 4095 characters");
        const summary = `Send a chat message to task ${task} in ${unit}: ${JSON.stringify(message)}`;
        if (globalOptions().dryRun) return setResult({ dryRun: summary });
        if (!globalOptions().yes && dependencies.interactive === false) throw new CliError("usage", "Mutation requires --yes when stdin is not interactive.");
        const plan = await (await application()).prepareChatSend(await resolvedProjectId(unit, application), nonEmpty(task, "task"), message);
        const confirmation = await requireConfirmation(summary, globalOptions(), dependencies, dependencies.confirmChatSend ? () => dependencies.confirmChatSend!(plan) : undefined);
        if (confirmation) return setResult(confirmation);
        setResult({ value: await (await application()).chatSend(plan) });
      }));

    const roles = program.command("roles").description("Teaching roles");
    roles.command("list").description("List teaching roles").option("--all", "Include inactive roles").action(async (options) => {
      setResult({ value: await (await application()).roles({ showAll: options.all === true }) });
    });

    program.command("commands").description("Describe the complete command tree").action(() => {
      setResult({ value: commandsJson(program) });
    });
    const skills = program.command("skills").description("Generate agent integration artifacts");
    skills.command("generate").description("Generate SKILL.md from the command tree").action(() => {
      setResult({ markdown: renderSkill(commandsJson(program)) });
    });
    describeArguments(program);
    for (const [title, names] of Object.entries(HELP_SECTIONS)) {
      for (const command of program.commands) if (names.includes(command.name())) helpSection(command, title);
    }
    examples(program, [
      "ontrack units",
      "ontrack tasks UNIT  # every task with its status and due date",
      "ontrack tasks UNIT 1.1 --json",
      "ontrack tasks read UNIT 1.1  # the task sheet as Markdown",
      "ontrack tasks submit UNIT 1.1 report.pdf",
      "ontrack chats UNIT 1.1",
    ]);
    return (current = program);
  };

  try {
    const args = normalizedArgv(argv);
    const ui = dependencies.ui ?? createUi({ input: process.stdin, output: process.stderr, interactive: false });
    if (args.length === 0) {
      build().outputHelp();
    } else {
      await parseWithPrompts(build, args, { ui, fillers: argumentFillers(application, ui) });
    }
    const options = globalOptions();
    format = resolveFormat(options, dependencies.stdoutIsTty ?? false);
    if (result?.dryRun) stderr += `${result.dryRun}\n`;
    else if (result?.markdown !== undefined) stdout += result.markdown.endsWith("\n") ? result.markdown : `${result.markdown}\n`;
    else if (result && "value" in result) {
      const selectedFields = fields(options);
      // JSON stays indented: the golden corpus pins this CLI's stdout byte for byte
      // against the Python implementation it replaced, formatting included.
      stdout += render(sanitized(result.value), {
        format,
        ...(selectedFields ? { fields: selectedFields } : {}),
        ...(!selectedFields && TABLE_COLUMNS[ranCommand] ? { columns: TABLE_COLUMNS[ranCommand] } : {}),
        ...(dependencies.stdoutColumns ? { width: dependencies.stdoutColumns } : {}),
      });
    }
    if (result?.diagnostic) stderr += result.diagnostic;
    return {
      exitCode: 0,
      stdout: redact(stdout, sensitiveValues),
      stderr: redact(stderr, sensitiveValues),
      ...(options.output ? { output: options.output } : {}),
    };
  } catch (error) {
    if (isInformationalExit(error)) {
      return { exitCode: 0, stdout: redact(stdout, sensitiveValues), stderr: "" };
    }
    const reported = reportError(sharedError(error), format);
    return { exitCode: reported.exitCode, stdout: "", stderr: redact(reported.text, sensitiveValues) };
  }
}
