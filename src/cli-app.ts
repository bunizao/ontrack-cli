import { parseArgs } from "node:util";

import { CliError, exitCodeFor } from "./errors.js";
import { renderJson, renderTable } from "./render.js";

export interface CliApplication {
  user(): Promise<unknown>;
  authCheck(): Promise<unknown>;
  projects(options: { readonly includeInactive: boolean }): Promise<unknown>;
  project(projectId: number): Promise<unknown>;
  tasks(projectId: number, options: { readonly statuses: readonly string[] }): Promise<unknown>;
  roles(options: { readonly showAll: boolean }): Promise<unknown>;
}

export interface CliExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Dependencies {
  readonly app: CliApplication;
  readonly version: string;
  readonly sensitiveValues?: readonly string[];
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

function help(): string {
  return [
    "Usage: ontrack <command> [options]",
    "",
    "Commands:",
    "  user                 Show the resolved signed-in user",
    "  auth check           Validate current credentials",
    "  projects             List current projects",
    "  project <project_id> Show one project",
    "  tasks <project_id>   List project tasks",
    "  roles                List teaching roles",
    "",
    "Options:",
    "  --json               Output JSON",
    "  --help               Show help",
    "  --version            Show version",
    "",
  ].join("\n");
}

function projectId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new CliError("usage", "project_id must be an integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new CliError("usage", "project_id must be a positive safe integer");
  return id;
}

function terminal(value: unknown): string {
  if (Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    const rows = value as Record<string, unknown>[];
    const keys = Object.keys(rows[0] ?? {}).slice(0, 7);
    return renderTable(rows, keys.map((key) => [key, key]));
  }
  if (typeof value === "object" && value !== null) {
    return renderTable(Object.entries(value).map(([key, item]) => ({ key, value: typeof item === "object" ? JSON.stringify(item) : item })), [["key", "Field"], ["value", "Value"]]);
  }
  return `${String(value)}\n`;
}

async function invoke(argv: readonly string[], app: CliApplication): Promise<{ value: unknown; json: boolean }> {
  const [command, ...rest] = argv;
  const common = { json: { type: "boolean" as const }, help: { type: "boolean" as const } };
  if (command === "user") {
    const parsed = parseArgs({ args: rest, options: common, allowPositionals: false, strict: true });
    return { value: await app.user(), json: parsed.values.json ?? false };
  }
  if (command === "auth" && rest[0] === "check") {
    const parsed = parseArgs({ args: rest.slice(1), options: common, allowPositionals: false, strict: true });
    return { value: await app.authCheck(), json: parsed.values.json ?? false };
  }
  if (command === "projects") {
    const parsed = parseArgs({ args: rest, options: { ...common, "include-inactive": { type: "boolean" } }, allowPositionals: false, strict: true });
    return { value: await app.projects({ includeInactive: parsed.values["include-inactive"] ?? false }), json: parsed.values.json ?? false };
  }
  if (command === "project") {
    const parsed = parseArgs({ args: rest, options: common, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== 1) throw new CliError("usage", "project requires one project_id integer");
    return { value: await app.project(projectId(parsed.positionals[0])), json: parsed.values.json ?? false };
  }
  if (command === "tasks") {
    const parsed = parseArgs({ args: rest, options: { ...common, status: { type: "string", multiple: true } }, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== 1) throw new CliError("usage", "tasks requires one project_id integer");
    return { value: await app.tasks(projectId(parsed.positionals[0]), { statuses: parsed.values.status ?? [] }), json: parsed.values.json ?? false };
  }
  if (command === "roles") {
    const parsed = parseArgs({ args: rest, options: { ...common, all: { type: "boolean" } }, allowPositionals: false, strict: true });
    return { value: await app.roles({ showAll: parsed.values.all ?? false }), json: parsed.values.json ?? false };
  }
  throw new CliError("usage", command ? `Unknown command: ${command}` : "A command is required");
}

export async function executeCli(argv: readonly string[], dependencies: Dependencies): Promise<CliExecution> {
  const sensitiveValues = dependencies.sensitiveValues ?? [];
  if (argv.length === 1 && argv[0] === "--help") return { exitCode: 0, stdout: help(), stderr: "" };
  if (argv.length === 1 && argv[0] === "--version") return { exitCode: 0, stdout: `ontrack ${dependencies.version}\n`, stderr: "" };
  const command = argv[0];
  const knownHelpTarget = ["user", "projects", "project", "tasks", "roles"].includes(command ?? "")
    || (command === "auth" && (argv[1] === "check" || argv[1] === "--help"));
  if (argv.includes("--help") && knownHelpTarget) return { exitCode: 0, stdout: help(), stderr: "" };
  try {
    const result = await invoke(argv, dependencies.app);
    const value = sanitized(result.value);
    const stdout = result.json ? renderJson(value) : terminal(value);
    return { exitCode: 0, stdout: redact(stdout, sensitiveValues), stderr: "" };
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
