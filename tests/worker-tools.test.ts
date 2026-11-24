import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { OnTrackService } from "../src/application-core.js";
import { CliError } from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import { OnTrackClient } from "../src/ontrack.js";
import type { KeeperStatus } from "../src/session-keeper.js";
import { createClock } from "../src/time.js";
import { createOnTrackMcpServer, type ToolContext } from "../src/worker/tools.js";

const BASE_URL = "https://school.example.edu";
const PROJECTS = [
  { id: 5183, unit: { id: 15, code: "FIT1061", name: "AI" } },
  { id: 6200, unit: { id: 16, code: "FIT1045", name: "Algorithms" } },
];
const PDF = new TextEncoder().encode("%PDF-1.4\n");
const STATUS: KeeperStatus = {
  username: "student",
  access_token_expiry: "2026-11-19T12:00:00.000Z",
  refresh_expires_at: "2026-11-26T05:00:00.000Z",
  okta: true,
  okta_blocked: null,
  okta_next_attempt_at: null,
  next_alarm_at: "2026-11-24T05:00:00.000Z",
};

function service(): OnTrackService {
  const http = new HttpClient({
    baseUrl: BASE_URL,
    credentials: { username: "student", accessToken: "secret" },
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/projects") return Response.json(PROJECTS);
      if (url.pathname === "/api/projects/5183") return Response.json({ ...PROJECTS[0], tasks: [{ id: 21, task_definition_id: 27, status: "not_started" }] });
      if (url.pathname === "/api/units/15") return Response.json({
        id: 15,
        code: "FIT1061",
        name: "AI",
        task_definitions: [{ id: 27, abbreviation: "1.1P", name: "Search", has_task_sheet: true }],
      });
      if (url.pathname === "/api/units/15/task_definitions/27/task_pdf") {
        return new Response(PDF, { headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=FIT1061-1.1P.pdf" } });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return new OnTrackService({ current: { baseUrl: BASE_URL, username: "student" } }, new OnTrackClient(http), createClock("2026-11-19T02:00:00Z"));
}

async function connect(context: Partial<ToolContext> = {}): Promise<Client> {
  const server = createOnTrackMcpServer({ version: "0.0.0-test", service: async () => service(), status: async () => STATUS, ...context });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function text(result: unknown): string {
  const content = (result as CallToolResult).content[0];
  assert.equal(content?.type, "text");
  return content.text;
}

export async function test_remote_mcp_marks_only_chat_history_as_changing_state(): Promise<void> {
  const { tools } = await (await connect()).listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["chat", "chats", "session", "task", "task_sheet", "tasks", "unit", "units", "whoami"]);
  // Reading a task's comments marks them read in OnTrack, so clients must ask first.
  const changing = tools.filter((tool) => tool.annotations?.readOnlyHint !== true);
  assert.deepEqual(changing.map((tool) => [tool.name, tool.annotations?.destructiveHint]), [["chat", false]]);
  assert.deepEqual(Object.keys(tools.find((tool) => tool.name === "chats")?.inputSchema.properties ?? {}), ["unit"]);
}

export async function test_remote_mcp_units_returns_the_project_list_as_json(): Promise<void> {
  const result = await (await connect()).callTool({ name: "units", arguments: {} });
  assert.notEqual(result.isError, true);
  const units = JSON.parse(text(result)) as Array<{ id: number }>;
  assert.deepEqual(units.map((unit) => unit.id), [5183, 6200]);
}

export async function test_remote_mcp_reports_an_unknown_unit_as_a_tool_error(): Promise<void> {
  const result = await (await connect()).callTool({ name: "task", arguments: { unit: "FIT9999", task: "1.1P" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /No unit matches FIT9999\. Your units: FIT1061, FIT1045/u);
}

export async function test_remote_mcp_passes_a_session_error_and_its_hint_to_the_client(): Promise<void> {
  const lapsed = new CliError("auth", "The OnTrack session has lapsed and this Worker has no Okta credentials.", undefined,
    "Run `ontrack mcp deploy` to store them.");
  const result = await (await connect({ service: async () => { throw lapsed; } })).callTool({ name: "whoami", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(text(result), `${lapsed.message}\n${lapsed.hint}`);
}

export async function test_remote_mcp_session_tool_needs_no_ontrack_session(): Promise<void> {
  const client = await connect({ service: async () => { throw new Error("must not be called"); } });
  const result = await client.callTool({ name: "session", arguments: {} });
  assert.deepEqual(JSON.parse(text(result)), STATUS);
}

export async function test_remote_mcp_task_sheet_returns_the_pdf_as_markdown(): Promise<void> {
  const calls: Array<{ name: string; type: string; size: number }> = [];
  const ai = {
    async toMarkdown(file: { name: string; blob: Blob }) {
      calls.push({ name: file.name, type: file.blob.type, size: file.blob.size });
      return { format: "markdown", data: "# FIT1061-1.1P.pdf\n\nSearch a maze." };
    },
  };
  const result = await (await connect({ ai })).callTool({ name: "task_sheet", arguments: { unit: "FIT1061", task: "1.1p" } });
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(text(result)), { project_id: 5183, unit_id: 15, task_definition_id: 27, task: "1.1P", name: "FIT1061-1.1P.pdf" });
  assert.deepEqual((result as CallToolResult).content[1], { type: "text", text: "# FIT1061-1.1P.pdf\n\nSearch a maze." });
  assert.deepEqual(calls, [{ name: "FIT1061-1.1P.pdf", type: "application/pdf", size: PDF.byteLength }]);
}

export async function test_remote_mcp_task_sheet_without_workers_ai_points_to_the_cli(): Promise<void> {
  const result = await (await connect()).callTool({ name: "task_sheet", arguments: { unit: "FIT1061", task: "1.1P" } });
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(text(result)).hint, "Run `ontrack tasks read FIT1061 1.1P` locally to read it.");
  assert.deepEqual((result as CallToolResult).content.slice(1), [
    { type: "text", text: "This server cannot convert FIT1061-1.1P.pdf to text. Download it with the local CLI." },
  ]);
}
