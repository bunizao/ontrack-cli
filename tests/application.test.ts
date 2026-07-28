import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OnTrackApplication, type SessionState } from "../src/application.js";
import type { AuthenticatedSession } from "../src/auth.js";
import { CliError } from "../src/errors.js";
import { HttpClient, type HttpRequestOptions } from "../src/http.js";
import { OnTrackClient } from "../src/ontrack.js";
import { createClock } from "../src/time.js";

function session(username: string): AuthenticatedSession {
  return {
    baseUrl: "https://school.example.edu",
    username,
    accessToken: "secret",
    authTokenExpiry: null,
    provenance: "environment",
    user: null,
  };
}

export async function test_user_validates_a_protected_endpoint(): Promise<void> {
  const http = {
    request: async (path: string): Promise<unknown> => {
      if (path === "api/auth/method") return { method: "saml" };
      throw new CliError("auth", "revoked", 401);
    },
  } as HttpClient;
  const app = new OnTrackApplication(
    { current: session("alice") },
    new OnTrackClient(http),
    createClock("2026-07-26T12:00:00Z"),
  );

  await assert.rejects(app.user(), (error) => error instanceof CliError && error.category === "auth");
}

export async function test_application_reads_the_current_session_after_refresh(): Promise<void> {
  const state: SessionState = { current: session("before-refresh") };
  const http = {
    request: async (path: string, options: HttpRequestOptions = {}): Promise<unknown> => {
      if (path === "api/auth/method") return { method: "saml" };
      if (path === "api/projects" && options.query?.include_inactive === true) return [];
      if (path === "api/unit_roles" && options.query?.active_only === false) return [];
      throw new Error(`unexpected request ${path}`);
    },
  } as HttpClient;
  const app = new OnTrackApplication(state, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));
  state.current = session("after-refresh");

  assert.deepEqual(await app.user(), {
    username: "after-refresh",
    base_url: "https://school.example.edu",
    auth_method: "saml",
  });
}

export async function test_application_downloads_a_task_sheet_by_abbreviation(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-task-sheet-"));
  const output = join(directory, "sheet.pdf");
  const urls: string[] = [];
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      urls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/projects/5183") return Response.json({
        id: 5183,
        unit: { id: 15, code: "FIT1061", name: "AI" },
        tasks: [{ id: 21, task_definition_id: 27, status: "not_started" }],
      });
      if (url.pathname === "/api/units/15") return Response.json({
        id: 15,
        code: "FIT1061",
        name: "AI",
        task_definitions: [{ id: 27, abbreviation: "1.1", name: "Search", has_task_sheet: true }],
      });
      return new Response(new TextEncoder().encode("%PDF-1.4\n"), {
        headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=FIT1061-1.1.pdf" },
      });
    },
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));
  try {
    const receipt = await app.taskSheetDownload(5183, "1.1", { output });
    assert.deepEqual(receipt, {
      project_id: 5183,
      unit_id: 15,
      task_definition_id: 27,
      task: "1.1",
      file_path: output,
      bytes_written: 9,
      content_type: "application/pdf",
    });
    assert.equal(await readFile(output, "utf8"), "%PDF-1.4\n");
    assert.deepEqual(urls, [
      "/api/projects/5183",
      "/api/units/15",
      "/api/units/15/task_definitions/27/task_pdf?as_attachment=true",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function test_application_downloads_from_unit_definitions_when_project_tasks_are_empty(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-unit-task-sheet-"));
  const output = join(directory, "sheet.pdf");
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/projects/5183") return Response.json({
        id: 5183,
        unit: { id: 15, code: "FIT1061", name: "AI" },
        tasks: [],
      });
      if (url.pathname === "/api/units/15") return Response.json({
        id: 15,
        code: "FIT1061",
        name: "AI",
        task_definitions: [
          { id: 1, abbreviation: "X", name: "Numeric collision", has_task_sheet: true },
          { id: 27, abbreviation: "1", name: "Search", has_task_sheet: true },
        ],
      });
      assert.equal(url.pathname, "/api/units/15/task_definitions/27/task_pdf");
      return new Response(new TextEncoder().encode("%PDF-1.4\n"), {
        headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=FIT1061-P1.pdf" },
      });
    },
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));
  try {
    const receipt = await app.taskSheetDownload(5183, "1", { output });
    assert.equal((receipt as { readonly task: string }).task, "1");
    assert.equal(await readFile(output, "utf8"), "%PDF-1.4\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function test_application_refuses_a_missing_task_resource_before_download(): Promise<void> {
  const urls: string[] = [];
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      urls.push(url.pathname);
      if (url.pathname === "/api/projects/5183") return Response.json({
        id: 5183,
        unit: { id: 15, code: "FIT1061", name: "AI" },
        tasks: [{ id: 21, task_definition_id: 27, status: "not_started" }],
      });
      return Response.json({
        id: 15,
        code: "FIT1061",
        name: "AI",
        task_definitions: [{ id: 27, abbreviation: "1.1", name: "Search", has_task_resources: false }],
      });
    },
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));

  await assert.rejects(
    app.taskResourcesDownload(5183, "1.1", {}),
    (error) => error instanceof CliError && error.category === "upstream_api" && /no resources/i.test(error.message),
  );
  assert.deepEqual(urls, ["/api/projects/5183", "/api/units/15"]);
}

export async function test_application_rejects_upstream_placeholder_files_without_writing_output(): Promise<void> {
  for (const kind of ["sheet", "resources"] as const) {
    const directory = await mkdtemp(join(tmpdir(), `ontrack-placeholder-${kind}-`));
    const output = join(directory, kind === "sheet" ? "sheet.pdf" : "resources.zip");
    const http = new HttpClient({
      baseUrl: "https://school.example.edu",
      credentials: { username: "student", accessToken: "secret" },
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/api/projects/5183") return Response.json({
          id: 5183,
          unit: { id: 15, code: "FIT1061", name: "AI" },
          tasks: [{ id: 21, task_definition_id: 27, status: "not_started" }],
        });
        if (url.pathname === "/api/units/15") return Response.json({
          id: 15,
          code: "FIT1061",
          name: "AI",
          task_definitions: [{
            id: 27,
            abbreviation: "1.1",
            name: "Search",
            has_task_sheet: true,
            has_task_resources: true,
          }],
        });
        return new Response(new TextEncoder().encode("%PDF-1.4\n"), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": "attachment; filename=FileNotFound.pdf",
          },
        });
      },
    });
    const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));
    try {
      const operation = kind === "sheet"
        ? app.taskSheetDownload(5183, "1.1", { output })
        : app.taskResourcesDownload(5183, "1.1", { output });
      await assert.rejects(operation, (error) => error instanceof CliError && /no (task sheet|resources)/iu.test(error.message));
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export async function test_application_lists_chat_summaries_without_marking_messages_read(): Promise<void> {
  const urls: string[] = [];
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      urls.push(url.pathname);
      if (url.pathname === "/api/projects/5183") return Response.json({
        id: 5183,
        unit: { id: 15, code: "FIT1061", name: "AI" },
        tasks: [{ id: 21, task_definition_id: 27, status: "rediscuss", num_new_comments: 3 }],
      });
      return Response.json({
        id: 15,
        code: "FIT1061",
        name: "AI",
        task_definitions: [{ id: 27, abbreviation: "1.1", name: "Search" }],
      });
    },
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));

  assert.deepEqual(await app.chats(5183, {}), [{
    task_definition_id: 27,
    task: "1.1",
    name: "Search",
    status: "rediscuss",
    unread_comments: 3,
  }]);
  assert.deepEqual(urls, ["/api/projects/5183", "/api/units/15"]);
}

export async function test_application_fetches_one_task_chat_by_abbreviation(): Promise<void> {
  const urls: string[] = [];
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      urls.push(url.pathname);
      if (url.pathname === "/api/projects/5183") return Response.json({
        id: 5183,
        unit: { id: 15, code: "FIT1061", name: "AI" },
        tasks: [{ id: 21, task_definition_id: 27, status: "rediscuss" }],
      });
      if (url.pathname === "/api/units/15") return Response.json({
        id: 15,
        code: "FIT1061",
        name: "AI",
        task_definitions: [{ id: 27, abbreviation: "1.1", name: "Search" }],
      });
      return Response.json([]);
    },
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));

  assert.deepEqual(await app.chats(5183, { task: "1.1" }), []);
  assert.deepEqual(urls, ["/api/projects/5183", "/api/units/15", "/api/projects/5183/task_def_id/27/comments"]);
}
