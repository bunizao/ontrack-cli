import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OnTrackApplication, type SessionState } from "../src/application.js";
import type { AuthenticatedSession } from "../src/auth.js";
import { CliError } from "../src/errors.js";
import { HttpClient, type HttpRequestOptions } from "../src/http.js";
import { OnTrackClient } from "../src/ontrack.js";
import { createClock } from "../src/time.js";
import { textPdf } from "./pdf-fixture.js";

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

export async function test_application_resolves_a_unique_active_project_by_unit_code(): Promise<void> {
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      assert.equal(url.pathname, "/api/projects");
      assert.equal(url.search, "?include_inactive=false");
      return Response.json([
        { id: 5183, unit: { id: 15, code: "FIT1061", name: "AI" } },
        { id: 6200, unit: { id: 16, code: "FIT1045", name: "Algorithms" } },
      ]);
    },
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));

  assert.equal(await app.resolveProject("fit1045"), 6200);
}

export async function test_application_prefers_one_active_project_without_scanning_inactive_duplicates(): Promise<void> {
  const queries: string[] = [];
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      queries.push(url.search);
      return Response.json([{ id: 6200, unit: { id: 16, code: "FIT1045", name: "Algorithms", active: true } }]);
    },
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));

  assert.equal(await app.resolveProject("FIT1045"), 6200);
  assert.deepEqual(queries, ["?include_inactive=false"]);
}

export async function test_application_refuses_an_ambiguous_unit_code(): Promise<void> {
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async () => Response.json([
      { id: 6200, unit: { id: 16, code: "FIT1045", name: "Algorithms" } },
      { id: 6300, unit: { id: 17, code: "FIT1045", name: "Algorithms" } },
    ]),
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));

  await assert.rejects(
    app.resolveProject("FIT1045"),
    (error) => error instanceof CliError && error.category === "usage" && /6200, 6300.*project ID/iu.test(error.message),
  );
}

export async function test_application_reports_ambiguous_project_ids_once_in_numeric_order(): Promise<void> {
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async () => Response.json([
      { id: 6300, unit: { id: 17, code: "FIT1045", name: "Algorithms" } },
      { id: 6200, unit: { id: 16, code: "FIT1045", name: "Algorithms" } },
      { id: 6300, unit: { id: 17, code: "FIT1045", name: "Algorithms" } },
    ]),
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));

  await assert.rejects(
    app.resolveProject("fit1045"),
    (error) => error instanceof CliError
      && error.category === "usage"
      && error.message === "Unit FIT1045 matches multiple projects: 6200, 6300. Use a project ID.",
  );
}

export async function test_application_updates_one_assigned_task_state_and_verifies_the_response(): Promise<void> {
  const requests: Request[] = [];
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/api/projects/5183") return Response.json({
        id: 5183,
        unit: { id: 15, code: "FIT1061", name: "AI" },
        tasks: [{ id: 21, task_definition_id: 27, status: "not_started" }],
      });
      if (url.pathname === "/api/units/15") return Response.json({
        id: 15,
        code: "FIT1061",
        name: "AI",
        task_definitions: [{ id: 27, abbreviation: "P1", name: "Search" }],
      });
      return Response.json({ id: 21, task_definition_id: 27, status: "working_on_it" });
    },
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));

  assert.deepEqual(await app.taskState(5183, "P1", "working_on_it"), {
    project_id: 5183,
    task_definition_id: 27,
    task: "P1",
    previous_status: "not_started",
    status: "working_on_it",
  });
  assert.equal(requests.at(-1)?.method, "PUT");
}

export async function test_application_prepares_then_submits_exact_task_files(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-submit-"));
  const report = join(directory, "report.pdf");
  const requests: Request[] = [];
  try {
    await writeFile(report, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    const http = new HttpClient({
      baseUrl: "https://school.example.edu",
      credentials: { username: "student", accessToken: "secret" },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname === "/api/projects/5183") return Response.json({
          id: 5183,
          unit: { id: 15, code: "FIT1061", name: "AI" },
          tasks: [{ id: 21, task_definition_id: 27, status: "working_on_it" }],
        });
        if (url.pathname === "/api/units/15") return Response.json({
          id: 15,
          code: "FIT1061",
          name: "AI",
          task_definitions: [{
            id: 27,
            abbreviation: "P1",
            name: "Search",
            upload_requirements: [{ key: "file0", name: "Report", type: "document" }],
          }],
        });
        return Response.json({ id: 21, task_definition_id: 27, status: "ready_for_feedback" }, { status: 201 });
      },
    });
    const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));

    const plan = await app.prepareTaskSubmission(5183, "P1", { files: [report], type: "ready_for_feedback" });
    assert.equal(requests.some((request) => request.method === "POST"), false);
    assert.equal(plan.uploads[0]?.requirementName, "Report");
    assert.equal(plan.uploads[0]?.filename, "report.pdf");

    assert.deepEqual(await app.submitTask(plan), {
      project_id: 5183,
      task_definition_id: 27,
      task: "P1",
      previous_status: "working_on_it",
      status: "ready_for_feedback",
      submission_type: "ready_for_feedback",
      processing_async: true,
    });
    assert.equal(requests.at(-1)?.method, "POST");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function test_application_rejects_an_unsupported_student_task_state_before_writing(): Promise<void> {
  const http = { request: async () => { throw new Error("must not request"); } } as unknown as HttpClient;
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));

  await assert.rejects(
    app.taskState(5183, "P1", "complete" as never),
    (error) => error instanceof CliError && error.category === "usage" && /not_started.*working_on_it.*need_help/u.test(error.message),
  );
}

export async function test_application_rejects_an_unsupported_submission_type_before_reading_project_data(): Promise<void> {
  const http = { request: async () => { throw new Error("must not request"); } } as unknown as HttpClient;
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));

  await assert.rejects(
    app.prepareTaskSubmission(5183, "P1", { files: ["report.pdf"], type: "working_on_it" }),
    (error) => error instanceof CliError && error.category === "usage" && /ready_for_feedback.*need_help.*assess_in_portfolio/u.test(error.message),
  );
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

export async function test_application_reads_a_task_sheet_as_markdown_without_writing_a_file(): Promise<void> {
  const pdf = textPdf(["Hello agent", "Second line"]);
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
        task_definitions: [{ id: 27, abbreviation: "P1", name: "Search", has_task_sheet: true }],
      });
      return new Response(Buffer.from(pdf), {
        headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=FIT1061-P1.pdf" },
      });
    },
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));
  assert.deepEqual(await app.taskRead(5183, "P1"), {
    project_id: 5183,
    unit_id: 15,
    task_definition_id: 27,
    task: "P1",
    pages: 1,
    markdown: "# FIT1061 P1 Task Sheet\n\nHello agent Second line\n",
  });
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

export async function test_application_sends_one_validated_text_comment_to_the_selected_task(): Promise<void> {
  const requests: Array<{ readonly method: string; readonly path: string; readonly body: string }> = [];
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/projects/5183") return Response.json({
        id: 5183,
        unit: { id: 15, code: "FIT1045", name: "Algorithms" },
        tasks: [{ id: 21, task_definition_id: 27, status: "working_on_it" }],
      });
      if (url.pathname === "/api/units/15") return Response.json({
        id: 15,
        code: "FIT1045",
        name: "Algorithms",
        task_definitions: [{ id: 27, abbreviation: "P1", name: "Search" }],
      });
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
      });
      return Response.json({
        id: 51,
        comment: "Please review this.",
        has_attachment: false,
        type: "text",
        is_new: false,
        reply_to_id: null,
        author: { id: 1, first_name: "Example", last_name: "Student", email: "student@example.invalid" },
        recipient: { id: 2, first_name: "Example", last_name: "Tutor", email: "tutor@example.invalid" },
        created_at: "2026-07-28T03:04:05Z",
        recipient_read_time: null,
      });
    },
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-28T04:00:00Z"));

  const plan = await app.prepareChatSend(5183, "P1", "Please review this.");
  assert.deepEqual(await app.chatSend(plan), {
    project_id: 5183,
    task_definition_id: 27,
    task: "P1",
    comment_id: 51,
    message: "Please review this.",
    created_at: "2026-07-28T03:04:05.000Z",
  });
  assert.deepEqual(requests, [{
    method: "POST",
    path: "/api/projects/5183/task_def_id/27/comments",
    body: "comment=Please+review+this.",
  }]);
}

export async function test_application_reports_upstream_chat_send_rejection_without_retrying_the_post(): Promise<void> {
  let posts = 0;
  const http = new HttpClient({
    baseUrl: "https://school.example.edu",
    credentials: { username: "student", accessToken: "secret" },
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/projects/5183") return Response.json({
        id: 5183,
        unit: { id: 15, code: "FIT1045", name: "Algorithms" },
        tasks: [{ id: 21, task_definition_id: 27, status: "working_on_it" }],
      });
      if (url.pathname === "/api/units/15") return Response.json({
        id: 15,
        code: "FIT1045",
        name: "Algorithms",
        task_definitions: [{ id: 27, abbreviation: "P1", name: "Search" }],
      });
      posts += 1;
      return Response.json({ error: "No comment added" }, { status: 403 });
    },
    refresh: async () => {
      throw new Error("POST requests must not refresh and retry");
    },
  });
  const app = new OnTrackApplication({ current: session("student") }, new OnTrackClient(http), createClock("2026-07-28T04:00:00Z"));

  await assert.rejects(
    app.chatSend(await app.prepareChatSend(5183, "P1", "Duplicate message")),
    (error) => error instanceof CliError
      && error.category === "upstream_api"
      && error.statusCode === 403
      && /chat message.*rejected/i.test(error.message),
  );
  assert.equal(posts, 1);
}
