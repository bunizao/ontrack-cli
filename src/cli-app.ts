import {
  CliError as ContractError,
  commandsJson,
  createProgram,
  insertDefaultVerb,
  mutating,
  render,
  reportError,
  resolveFormat,
  type NounSpec,
  type OutputFormat,
} from "@bunizao/cli-kit";

import { CliError } from "./errors.js";
import { assertSupportedRuntime } from "./runtime.js";
import { renderSkill } from "./skill.js";
import { submissionType, type TaskSubmissionOptions, type TaskSubmissionPlan } from "./submission.js";

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
  taskState(projectId: number, task: string, state: string): Promise<unknown>;
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
  readonly app: CliApplication;
  readonly authLogin?: () => Promise<unknown>;
  readonly authLogout?: () => Promise<unknown>;
  readonly version: string;
  readonly sensitiveValues?: readonly string[];
  readonly onDiagnostic?: (message: string) => void;
  readonly confirmChatSend?: (details: ChatSendConfirmation) => Promise<boolean>;
  readonly confirmTaskSubmit?: (plan: TaskSubmissionPlan) => Promise<boolean>;
  readonly confirmMutation?: (summary: string) => Promise<boolean>;
  readonly interactive?: boolean;
  readonly stdoutIsTty?: boolean;
  readonly runtime?: { readonly nodeVersion: string; readonly bunVersion?: string };
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
  readonly quiet?: boolean;
  readonly yes?: boolean;
  readonly dryRun?: boolean;
}

export const nounSpecs: readonly NounSpec[] = [
  { name: "units", aliases: ["courses", "projects"], verbs: ["list", "show", "get"], defaultByArity: { 0: "list", 1: "show" } },
  { name: "tasks", verbs: ["list", "show", "read", "get", "set", "submit"], valueFlags: ["--status"], defaultByArity: { 1: "list", 2: "show" } },
  { name: "chats", verbs: ["list", "read", "send", "mark-read"], defaultByArity: { 1: "list", 2: "read" } },
  { name: "roles", verbs: ["list"], defaultByArity: { 0: "list" } },
];

const secretKeys = new Set([
  "authentication_token", "auth_token", "access_token", "refresh_token",
  "authenticationToken", "authToken", "accessToken", "refreshToken",
]);
const taskStates = ["not_started", "working_on_it", "need_help"] as const;

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

async function resolvedProjectId(value: string, app: CliApplication): Promise<number> {
  const reference = value.trim();
  if (/^\d+$/u.test(reference)) return positiveId(reference);
  if (/^[a-z]{2,}\d{3,}[a-z0-9_-]*$/iu.test(reference)) return app.resolveProject(reference);
  throw new CliError("usage", "unit must be a project ID or unit code such as FIT1045");
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
  try {
    if (dependencies.runtime) assertSupportedRuntime(dependencies.runtime.nodeVersion, dependencies.runtime.bunVersion);
    format = selectedFormat(argv, dependencies.stdoutIsTty ?? false);
  } catch (error) {
    const reported = reportError(sharedError(error), "table");
    return { exitCode: reported.exitCode, stdout: "", stderr: redact(reported.text, sensitiveValues) };
  }

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
  const setResult = (value: InvocationResult): void => { result = value; };
  const globalOptions = (): GlobalOptions => program.opts<GlobalOptions>();

  program.command("user").description("Show the signed-in user").action(async () => {
    setResult({ value: await dependencies.app.user() });
  });

  const auth = program.command("auth").description("Manage authentication");
  auth.command("login").description("Sign in through OnTrack").action(async () => {
    if (!dependencies.authLogin) throw new CliError("config", "Interactive login is unavailable.");
    setResult({ value: await dependencies.authLogin() });
  });
  auth.command("status").description("Validate current credentials").action(async () => {
    setResult({ value: await dependencies.app.authCheck() });
  });
  auth.command("logout").description("Remove the cached session").action(async () => {
    if (!dependencies.authLogout) throw new CliError("config", "Logout is unavailable.");
    setResult({ value: await dependencies.authLogout() });
  });

  const units = program.command("units").aliases(["courses", "projects"]).description("OnTrack enrolments");
  units.command("list").description("List units").option("--include-inactive", "Include past units").action(async (options) => {
    setResult({ value: await dependencies.app.projects({ includeInactive: options.includeInactive === true }) });
  });
  units.command("show <unit>").description("Show one unit").action(async (unit) => {
    setResult({ value: await dependencies.app.project(await resolvedProjectId(unit, dependencies.app)) });
  });
  units.command("get <unit>").description("Download unit resources")
    .option("--dest <path>", "Destination ZIP")
    .option("--force", "Replace an existing destination")
    .action(async (unit, options) => {
      setResult({ value: await dependencies.app.resourcesDownload(await resolvedProjectId(unit, dependencies.app), downloadOptions(options)) });
    });

  const tasks = program.command("tasks").description("OnTrack tasks");
  tasks.command("list <unit>").description("List tasks")
    .option("--status <status...>", "Filter by raw task status")
    .action(async (unit, options) => {
      setResult({ value: await dependencies.app.tasks(await resolvedProjectId(unit, dependencies.app), { statuses: options.status ?? [] }) });
    });
  tasks.command("show <unit> <task>").description("Show one task").action(async (unit, task) => {
    setResult({ value: await dependencies.app.taskShow(await resolvedProjectId(unit, dependencies.app), nonEmpty(task, "task")) });
  });
  tasks.command("read <unit> <task>").description("Print a task sheet as Markdown").action(async (unit, task) => {
    const value = await dependencies.app.taskRead(await resolvedProjectId(unit, dependencies.app), nonEmpty(task, "task"));
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
      const projectId = await resolvedProjectId(unit, dependencies.app);
      const reference = nonEmpty(task, "task");
      const value = options.resources
        ? await dependencies.app.taskResourcesDownload(projectId, reference, downloadOptions(options))
        : await dependencies.app.taskSheetDownload(projectId, reference, downloadOptions(options));
      setResult({ value });
    });
  mutating(tasks.command("set <unit> <task> <state>").description("Change task workflow state").action(async (unit, task, state) => {
    if (!taskStates.includes(state as typeof taskStates[number])) {
      throw new CliError("usage", `state must be one of: ${taskStates.join(", ")}`);
    }
    const summary = `Set task ${task} in ${unit} to ${state}.`;
    const confirmation = await requireConfirmation(summary, globalOptions(), dependencies);
    if (confirmation) return setResult(confirmation);
    setResult({ value: await dependencies.app.taskState(await resolvedProjectId(unit, dependencies.app), nonEmpty(task, "task"), nonEmpty(state, "state")) });
  }));
  mutating(tasks.command("submit <unit> <task>").description("Submit task files")
    .requiredOption("--file <path...>", "Files in upload-requirement order")
    .option("--type <type>", "Submission type", "ready_for_feedback")
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
      const projectId = await resolvedProjectId(unit, dependencies.app);
      const base = { files, type, acceptTiiEula: options.acceptTiiEula === true };
      const plan = await dependencies.app.prepareTaskSubmission(projectId, nonEmpty(task, "task"), comment ? { ...base, comment } : base);
      const confirmation = await requireConfirmation(summary, globalOptions(), dependencies, dependencies.confirmTaskSubmit ? () => dependencies.confirmTaskSubmit!(plan) : undefined);
      if (confirmation) return setResult(confirmation);
      setResult({ value: await dependencies.app.submitTask(plan) });
    }));

  const chats = program.command("chats").description("Task chats");
  chats.command("list <unit>").description("List unread chat counts").action(async (unit) => {
    setResult({ value: await dependencies.app.chats(await resolvedProjectId(unit, dependencies.app), {}) });
  });
  chats.command("read <unit> <task>").description("Read task chat history").action(async (unit, task) => {
    const diagnostic = "warning: OnTrack marks non-discussion comments read when chat history is fetched.\n";
    if (!globalOptions().quiet) dependencies.onDiagnostic?.(diagnostic);
    setResult({
      value: await dependencies.app.chats(await resolvedProjectId(unit, dependencies.app), { task: nonEmpty(task, "task") }),
      ...(!globalOptions().quiet && !dependencies.onDiagnostic ? { diagnostic } : {}),
    });
  });
  mutating(chats.command("mark-read <unit> <task>").description("Mark task chat comments read").action(async (unit, task) => {
    const summary = `Mark chat comments read for task ${task} in ${unit}.`;
    const confirmation = await requireConfirmation(summary, globalOptions(), dependencies);
    if (confirmation) return setResult(confirmation);
    setResult({ value: await dependencies.app.chatMarkRead(await resolvedProjectId(unit, dependencies.app), nonEmpty(task, "task")) });
  }));
  mutating(chats.command("send <unit> <task>").description("Send a task chat message")
    .requiredOption("--message <text>", "Exact message to send")
    .action(async (unit, task, options) => {
      const message = nonEmpty(options.message, "chat message");
      if (Array.from(message).length > 4_095) throw new CliError("usage", "chat message must not exceed 4095 characters");
      const summary = `Send a chat message to task ${task} in ${unit}: ${JSON.stringify(message)}`;
      if (globalOptions().dryRun) return setResult({ dryRun: summary });
      if (!globalOptions().yes && dependencies.interactive === false) throw new CliError("usage", "Mutation requires --yes when stdin is not interactive.");
      const plan = await dependencies.app.prepareChatSend(await resolvedProjectId(unit, dependencies.app), nonEmpty(task, "task"), message);
      const confirmation = await requireConfirmation(summary, globalOptions(), dependencies, dependencies.confirmChatSend ? () => dependencies.confirmChatSend!(plan) : undefined);
      if (confirmation) return setResult(confirmation);
      setResult({ value: await dependencies.app.chatSend(plan) });
    }));

  const roles = program.command("roles").description("Teaching roles");
  roles.command("list").description("List teaching roles").option("--all", "Include inactive roles").action(async (options) => {
    setResult({ value: await dependencies.app.roles({ showAll: options.all === true }) });
  });

  program.command("commands").description("Describe the complete command tree").action(() => {
    setResult({ value: commandsJson(program) });
  });
  const skills = program.command("skills").description("Generate agent integration artifacts");
  skills.command("generate").description("Generate SKILL.md from the command tree").action(() => {
    setResult({ markdown: renderSkill(commandsJson(program)) });
  });

  try {
    const normalizedArgv = insertDefaultVerb(argv, nounSpecs);
    if (normalizedArgv.length === 0) {
      program.outputHelp();
    } else {
      await program.parseAsync(normalizedArgv, { from: "user" });
    }
    const options = globalOptions();
    format = resolveFormat(options, dependencies.stdoutIsTty ?? false);
    if (result?.dryRun) stderr += `${result.dryRun}\n`;
    else if (result?.markdown !== undefined) stdout += result.markdown.endsWith("\n") ? result.markdown : `${result.markdown}\n`;
    else if (result && "value" in result) {
      const selectedFields = fields(options);
      stdout += render(sanitized(result.value), { format, ...(selectedFields ? { fields: selectedFields } : {}) });
    }
    if (result?.diagnostic) stderr += result.diagnostic;
    return {
      exitCode: 0,
      stdout: redact(stdout, sensitiveValues),
      stderr: redact(stderr, sensitiveValues),
      ...(options.output ? { output: options.output } : {}),
    };
  } catch (error) {
    const candidate = error as { readonly exitCode?: unknown };
    if (candidate.exitCode === 0) {
      return { exitCode: 0, stdout: redact(stdout, sensitiveValues), stderr: "" };
    }
    const reported = reportError(sharedError(error), format);
    return { exitCode: reported.exitCode, stdout: "", stderr: redact(reported.text, sensitiveValues) };
  }
}
