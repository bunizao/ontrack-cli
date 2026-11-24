import { fileContent, type MarkdownConverter } from "@bunizao/cli-kit/file-content";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";

import type { OnTrackService } from "../application-core.js";
import { CliError } from "../errors.js";
import type { KeeperStatus } from "../session-keeper.js";

// The remote MCP's tools: views over OnTrackService. No Worker API here,
// so the tests drive it in Node.

export interface ToolContext {
  readonly version: string;
  /** Built per call: a session renewal can take seconds, and `session` needs none. */
  readonly service: () => Promise<OnTrackService>;
  readonly status: () => Promise<KeeperStatus>;
  /** Workers AI, which turns task sheet PDFs into Markdown; without it task_sheet says so. */
  readonly ai?: MarkdownConverter | undefined;
}

const unit = z.string().min(1).describe("A unit code or name as `units` shows it (e.g. FIT2004), or a project ID.");
const task = z.string().min(1).describe("A task abbreviation as `tasks` shows it (e.g. 1.1P), or a task definition ID.");
const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

export function createOnTrackMcpServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: "ontrack", version: context.version });

  server.registerTool("whoami", {
    description: "The signed-in OnTrack user.",
    annotations: readOnly,
  }, () => run(async () => (await context.service()).user()));

  server.registerTool("units", {
    description: "Your OnTrack units (projects), with the project ID each tool also accepts.",
    inputSchema: { include_inactive: z.boolean().default(false).describe("Include units from past teaching periods.") },
    annotations: readOnly,
  }, ({ include_inactive }) => run(async () => (await context.service()).projects({ includeInactive: include_inactive })));

  server.registerTool("unit", {
    description: "One unit: its tasks with status, due dates and target grades.",
    inputSchema: { unit },
    annotations: readOnly,
  }, (input) => run(async () => {
    const service = await context.service();
    return service.project(await projectId(service, input.unit));
  }));

  server.registerTool("tasks", {
    description: "The tasks in a unit, optionally only those with the given statuses.",
    inputSchema: {
      unit,
      statuses: z.array(z.string()).default([]).describe("OnTrack statuses to keep, e.g. not_started, working_on_it, fix_and_resubmit."),
    },
    annotations: readOnly,
  }, (input) => run(async () => {
    const service = await context.service();
    return service.tasks(await projectId(service, input.unit), { statuses: input.statuses });
  }));

  server.registerTool("task", {
    description: "One task: status, dates, description and upload requirements.",
    inputSchema: { unit, task },
    annotations: readOnly,
  }, (input) => run(async () => {
    const service = await context.service();
    return service.taskShow(await projectId(service, input.unit), input.task);
  }));

  server.registerTool("task_sheet", {
    description: "One task's task sheet (the PDF brief: what to do, what to submit, how it is checked) as Markdown.",
    inputSchema: { unit, task },
    annotations: readOnly,
  }, (input) => guarded(async () => {
    const service = await context.service();
    const { bytes, ...sheet } = await service.taskSheet(await projectId(service, input.unit), input.task);
    const file = await fileContent({ name: sheet.name, mimeType: "application/pdf", bytes }, { ai: context.ai });
    const note = file.kind === "link" ? { hint: `Run \`ontrack tasks read ${input.unit} ${sheet.task}\` locally to read it.` } : {};
    return { content: [{ type: "text", text: JSON.stringify({ ...sheet, ...note }, null, 2) }, ...file.content] };
  }));

  server.registerTool("chats", {
    description: "Unread comment counts per task in a unit.",
    inputSchema: { unit },
    annotations: readOnly,
  }, (input) => run(async () => {
    const service = await context.service();
    return service.chats(await projectId(service, input.unit), {});
  }));

  // OnTrack marks a task's comments read when their history is fetched, so this is
  // the one tool that changes state; clients ask before calling it.
  server.registerTool("chat", {
    description: "One task's comment history. Fetching it marks those comments read in OnTrack.",
    inputSchema: { unit, task },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => run(async () => {
    const service = await context.service();
    return service.chats(await projectId(service, input.unit), { task: input.task });
  }));

  server.registerTool("session", {
    description: "How this server keeps its OnTrack session: expiries, Okta renewal and the next scheduled renewal.",
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => run(context.status));

  return server;
}

async function projectId(service: OnTrackService, reference: string): Promise<number> {
  const trimmed = reference.trim();
  return /^\d+$/u.test(trimmed) ? Number(trimmed) : service.resolveProject(trimmed);
}

function run(action: () => Promise<unknown>): Promise<CallToolResult> {
  return guarded(async () => ({ content: [{ type: "text", text: JSON.stringify(await action(), null, 2) }] }));
}

async function guarded(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    const text = error.hint ? `${error.message}\n${error.hint}` : error.message;
    return { isError: true, content: [{ type: "text", text }] };
  }
}
