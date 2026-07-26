import assert from "node:assert/strict";

import { CliError } from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import { OnTrackClient } from "../src/ontrack.js";

export async function test_ontrack_projects_sends_auth_headers_and_validates_the_response(): Promise<void> {
  let request: Request | undefined;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    request = new Request(input, init);
    return Response.json([{ id: 7, unit: { id: 9, code: "FIT9999", name: "Example Unit" } }]);
  };
  const client = new OnTrackClient(new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "secret-token" },
    fetch,
  }));

  const projects = await client.getProjects(true);

  assert.equal(projects[0]?.unit.code, "FIT9999");
  assert.equal(request?.url, "https://ontrack.example.edu/api/projects?include_inactive=true");
  assert.equal(request?.headers.get("Username"), "student");
  assert.equal(request?.headers.get("Auth-Token"), "secret-token");
  assert.equal(request?.headers.get("Accept"), "application/json");
}

export async function test_http_401_is_an_auth_error(): Promise<void> {
  const client = new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "expired" },
    fetch: async () => Response.json({ error: "Unauthorized" }, { status: 401 }),
  });

  await assert.rejects(
    client.request("api/projects"),
    (error) => error instanceof CliError && error.category === "auth" && error.statusCode === 401,
  );
}

export async function test_get_refreshes_after_419_and_retries_once(): Promise<void> {
  const tokens: string[] = [];
  let refreshes = 0;
  const client = new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "expired" },
    refresh: async () => {
      refreshes += 1;
      return { username: "student", accessToken: "renewed" };
    },
    fetch: async (input, init) => {
      tokens.push(new Request(input, init).headers.get("Auth-Token") ?? "");
      return tokens.length === 1
        ? Response.json({ error: "expired" }, { status: 419 })
        : Response.json([]);
    },
  });

  assert.deepEqual(await client.request("api/projects"), []);
  assert.equal(refreshes, 1);
  assert.deepEqual(tokens, ["expired", "renewed"]);
}

export async function test_concurrent_419_responses_share_one_refresh(): Promise<void> {
  let refreshes = 0;
  const client = new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "expired" },
    refresh: async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { username: "student", accessToken: "renewed" };
    },
    fetch: async (input, init) => {
      const token = new Request(input, init).headers.get("Auth-Token");
      return token === "expired"
        ? Response.json({ error: "expired" }, { status: 419 })
        : Response.json([]);
    },
  });
  assert.deepEqual(await Promise.all([client.request("api/projects"), client.request("api/unit_roles")]), [[], []]);
  assert.equal(refreshes, 1);
}

export async function test_external_abort_is_a_cancellation_error(): Promise<void> {
  const controller = new AbortController();
  const client = new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "token" },
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });

  const pending = client.request("api/projects", { signal: controller.signal });
  controller.abort();

  await assert.rejects(
    pending,
    (error) => error instanceof CliError && error.category === "cancellation",
  );
}

export async function test_timeout_aborts_an_in_flight_request_as_a_network_error(): Promise<void> {
  const client = new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "token" },
    timeoutMs: 5,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });

  await assert.rejects(
    client.request("api/projects"),
    (error) => error instanceof CliError && error.category === "network" && /timed out/i.test(error.message),
  );
}

export async function test_timeout_remains_active_while_reading_response_body(): Promise<void> {
  const external = new AbortController();
  const client = new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "token" },
    timeoutMs: 5,
    fetch: async (_input, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
      },
    })),
  });
  const request = client.request("api/projects", { signal: external.signal });
  const outcome = await Promise.race([
    request.then(() => "resolved", (error: unknown) => error),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  if (outcome === "hung") {
    external.abort();
    await request.catch(() => undefined);
  }
  assert.ok(outcome instanceof CliError && outcome.category === "network" && /timed out/i.test(outcome.message));
}

export async function test_invalid_json_and_invalid_entity_shapes_are_contract_errors(): Promise<void> {
  for (const response of [
    new Response("not-json", { headers: { "Content-Type": "application/json" } }),
    Response.json({ not: "an array" }),
  ]) {
    const client = new OnTrackClient(new HttpClient({
      baseUrl: "https://ontrack.example.edu",
      credentials: { username: "student", accessToken: "token" },
      fetch: async () => response.clone(),
    }));
    await assert.rejects(
      client.getProjects(),
      (error) => error instanceof CliError && error.category === "upstream_contract",
    );
  }
}

export async function test_unknown_task_status_survives_transport_and_reader_integration(): Promise<void> {
  const client = new OnTrackClient(new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "token" },
    fetch: async () => Response.json({
      id: 7,
      unit: { id: 9, code: "FIT9999", name: "Example Unit" },
      tasks: [{ id: 11, task_definition_id: 12, status: "future_status" }],
    }),
  }));

  assert.equal((await client.getProject(7)).tasks[0]?.status, "future_status");
}

export async function test_non_idempotent_419_does_not_refresh_or_retry(): Promise<void> {
  let requests = 0;
  let refreshes = 0;
  const client = new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "expired" },
    refresh: async () => {
      refreshes += 1;
      return { username: "student", accessToken: "renewed" };
    },
    fetch: async () => {
      requests += 1;
      return Response.json({ error: "expired" }, { status: 419 });
    },
  });

  await assert.rejects(
    client.request("api/projects/7", { method: "POST", body: "payload" }),
    (error) => error instanceof CliError && error.category === "auth" && error.statusCode === 419,
  );
  assert.equal(requests, 1);
  assert.equal(refreshes, 0);
}

export async function test_repeated_419_stops_after_one_refresh(): Promise<void> {
  let requests = 0;
  let refreshes = 0;
  const client = new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "expired" },
    refresh: async () => {
      refreshes += 1;
      return { username: "student", accessToken: "still-expired" };
    },
    fetch: async () => {
      requests += 1;
      return Response.json({ error: "expired" }, { status: 419 });
    },
  });

  await assert.rejects(
    client.request("api/projects"),
    (error) => error instanceof CliError && error.category === "auth" && error.statusCode === 419,
  );
  assert.equal(requests, 2);
  assert.equal(refreshes, 1);
}

export async function test_fetch_failure_is_a_network_error(): Promise<void> {
  const client = new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "token" },
    fetch: async () => { throw new TypeError("connection refused"); },
  });

  await assert.rejects(
    client.request("api/projects"),
    (error) => error instanceof CliError && error.category === "network" && /connection refused/i.test(error.message),
  );
}

export async function test_cutover_read_routes_use_expected_urls_and_readers(): Promise<void> {
  const urls: string[] = [];
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    urls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/auth/method") return Response.json({ method: "saml", redirect_to: "https://sso.example.edu" });
    if (url.pathname === "/api/projects") return Response.json([]);
    if (url.pathname === "/api/projects/7") return Response.json({ id: 7, unit: { id: 9, code: "FIT9999", name: "Example Unit" }, tasks: [] });
    if (url.pathname === "/api/units/9") return Response.json({ id: 9, code: "FIT9999", name: "Example Unit", task_definitions: [] });
    if (url.pathname === "/api/unit_roles") return Response.json([{ id: 3, role: "Tutor", unit: { id: 9, code: "FIT9999", name: "Example Unit" } }]);
    return Response.json({ error: "unexpected route" }, { status: 404 });
  };
  const client = new OnTrackClient(new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "token" },
    fetch,
  }));

  assert.equal((await client.getAuthMethod()).method, "saml");
  assert.deepEqual(await client.getProjects(false), []);
  assert.equal((await client.getProject(7)).id, 7);
  assert.equal((await client.getUnit(9)).code, "FIT9999");
  assert.equal((await client.getRoles(false))[0]?.role, "Tutor");
  assert.deepEqual(urls, [
    "/api/auth/method",
    "/api/projects?include_inactive=false",
    "/api/projects/7",
    "/api/units/9",
    "/api/unit_roles?active_only=false",
  ]);
}

export async function test_invalid_auth_method_shape_is_a_contract_error(): Promise<void> {
  const client = new OnTrackClient(new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "token" },
    fetch: async () => Response.json({ method: 42 }),
  }));

  await assert.rejects(
    client.getAuthMethod(),
    (error) => error instanceof CliError && error.category === "upstream_contract",
  );
}

export async function test_auth_method_accepts_null_redirect(): Promise<void> {
  const client = new OnTrackClient(new HttpClient({
    baseUrl: "https://ontrack.example.edu",
    credentials: { username: "student", accessToken: "token" },
    fetch: async () => Response.json({ method: "database", redirect_to: null }),
  }));

  assert.deepEqual(await client.getAuthMethod(), { method: "database", redirect_to: null });
}
