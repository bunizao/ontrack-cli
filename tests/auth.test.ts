import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loginAuthenticatedSession,
  nodeLoopbackListener,
  resolveAuthenticatedSession as resolveAuthenticatedSessionWithRuntime,
  type ResolveAuthenticatedSessionOptions,
} from "../src/auth.js";
import type { BrowserCookie, BrowserCookieCandidate } from "../src/browser-cookies.js";
import { loadConfig, resolveConfigPaths, resolveCredentialSource } from "../src/config.js";
import { CliError } from "../src/errors.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ontrack-auth-test-"));
}

function resolveAuthenticatedSession(options: ResolveAuthenticatedSessionOptions) {
  return resolveAuthenticatedSessionWithRuntime(options);
}

function browserCandidate(cookies: readonly BrowserCookie[]): readonly BrowserCookieCandidate[] {
  return [{ source: "Chrome:Default", cookies }];
}

function validCookies(): readonly BrowserCookie[] {
  return [
    { name: "username", value: "alice", domain: "school.example.edu", path: "/api/auth" },
    { name: "refresh_token", value: "refresh-secret", domain: "school.example.edu", path: "/api/auth" },
  ];
}

function exchangeResponse(payload: unknown): typeof fetch {
  return async () => Response.json(payload);
}

export function test_config_paths_honor_explicit_xdg_and_platform_fallbacks(): void {
  assert.deepEqual(resolveConfigPaths({
    env: { ONTRACK_CONFIG: "/custom/ontrack.yaml", XDG_CONFIG_HOME: "/ignored" },
    platform: "linux",
    homeDir: "/home/alice",
    cwd: "/work",
  }), {
    configDir: "/custom",
    configFile: "/custom/ontrack.yaml",
    sessionFile: "/custom/session.json",
  });
  assert.equal(resolveConfigPaths({
    env: { XDG_CONFIG_HOME: "/xdg" },
    platform: "linux",
    homeDir: "/home/alice",
    cwd: "/work",
  }).configFile, "/xdg/ontrack-cli/config.yaml");
  assert.equal(resolveConfigPaths({
    env: { XDG_CONFIG_HOME: "/xdg" },
    platform: "linux",
    homeDir: "/home/alice",
    cwd: "/work",
    cwdConfigExists: true,
  }).configFile, "/work/config.yaml");
  assert.equal(resolveConfigPaths({
    env: {},
    platform: "darwin",
    homeDir: "/Users/alice",
    cwd: "/work",
  }).configFile, "/Users/alice/.config/ontrack-cli/config.yaml");
  assert.equal(resolveConfigPaths({
    env: { ONTRACK_CONFIG: "~/.ontrack/config.yaml" },
    platform: "darwin",
    homeDir: "/Users/alice",
    cwd: "/work",
  }).configFile, "/Users/alice/.ontrack/config.yaml");
  assert.equal(resolveConfigPaths({
    env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" },
    platform: "win32",
    homeDir: "C:\\Users\\alice",
    cwd: "C:\\work",
  }).configFile, "C:\\Users\\alice\\AppData\\Roaming\\ontrack-cli\\config.yaml");
  assert.equal(resolveConfigPaths({
    env: { ONTRACK_CONFIG: "~\\ontrack\\config.yaml" },
    platform: "win32",
    homeDir: "C:\\Users\\alice",
    cwd: "C:\\work",
  }).configFile, "C:\\Users\\alice\\ontrack\\config.yaml");
}

export function test_credential_precedence_is_environment_config_then_migration(): void {
  const config = {
    username: "config-user",
    auth_token: "config-token",
    doubtfire_user: { username: "migration-user", authenticationToken: "migration-token" },
  };
  assert.deepEqual(resolveCredentialSource({
    ONTRACK_USERNAME: "env-user",
    ONTRACK_TOKEN: "env-token",
    ONTRACK_DOUBTFIRE_USER_JSON: JSON.stringify({ username: "env-migration", authenticationToken: "env-migration-token" }),
  }, config), { username: "env-user", accessToken: "env-token", provenance: "environment", user: null });
  assert.deepEqual(resolveCredentialSource({}, config), {
    username: "config-user",
    accessToken: "config-token",
    provenance: "config",
    user: null,
  });
  assert.deepEqual(resolveCredentialSource({}, {
    doubtfire_user: { username: "migration-user", authenticationToken: "migration-token" },
  }), {
    username: "migration-user",
    accessToken: "migration-token",
    provenance: "migration",
    user: {
      id: null,
      username: "migration-user",
      first_name: null,
      last_name: null,
      email: null,
      nickname: null,
    },
  });
}

export async function test_nested_yaml_migration_credentials_remain_supported(): Promise<void> {
  const directory = await temporaryDirectory();
  const configFile = join(directory, "config.yaml");
  await writeFile(configFile, [
    "base_url: https://school.example.edu",
    "doubtfire_user:",
    "  username: migration-user",
    "  authenticationToken: migration-token",
    "",
  ].join("\n"));
  const config = loadConfig({ configDir: directory, configFile, sessionFile: join(directory, "session.json") });
  assert.equal(resolveCredentialSource({}, config)?.accessToken, "migration-token");
}

export async function test_browser_cookie_exchange_filters_inapplicable_cookies(): Promise<void> {
  const directory = await temporaryDirectory();
  let cookieHeader = "";
  const session = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    now: () => new Date("2029-01-01T00:00:00Z"),
    browserCookieProvider: async () => browserCandidate([
      { name: "valid", value: "kept", domain: "school.example.edu", path: "/api", secure: true, expires: "2030-01-01T00:00:00Z" },
      { name: "session", value: "kept", domain: "school.example.edu", path: "/api", secure: true, expires: 0 },
      { name: "normalized-parent-domain", value: "kept", domain: "example.edu", path: "/api", secure: true },
      { name: "unrelated-domain", value: "dropped", domain: "other.example", path: "/api", secure: true },
      { name: "wrong-path", value: "dropped", domain: "school.example.edu", path: "/account", secure: true },
      { name: "expired", value: "dropped", domain: "school.example.edu", path: "/", secure: true, expires: "2020-01-01T00:00:00Z" },
    ]),
    fetch: async (input, init) => {
      cookieHeader = new Headers(init?.headers).get("Cookie") ?? "";
      return exchangeResponse({
        auth_token: "access-secret",
        auth_token_expiry: "2030-01-01T00:00:00Z",
        user: { username: "alice" },
      })(input, init);
    },
  });
  assert.equal(session.provenance, "browser");
  assert.equal(cookieHeader, "valid=kept; session=kept; normalized-parent-domain=kept");

  await assert.rejects(resolveAuthenticatedSession({
    baseUrl: "http://school.example.edu",
    sessionFile: join(directory, "http-session.json"),
    env: {},
    now: () => new Date("2029-01-01T00:00:00Z"),
    browserCookieProvider: async () => browserCandidate([
      { name: "refresh_token", value: "secret", domain: "school.example.edu", path: "/api/auth", secure: true },
    ]),
  }), /ontrack auth login/iu);
}

export async function test_valid_cached_session_is_reused_and_expired_session_is_replaced_from_browser(): Promise<void> {
  const directory = await temporaryDirectory();
  const sessionFile = join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({
    base_url: "https://school.example.edu",
    username: "cached-user",
    access_token: "cached-token",
    auth_token_expiry: "2030-01-01T00:00:00.000Z",
    provenance: "okta",
  }));
  const cached = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile,
    env: {},
    now: () => new Date("2029-01-01T00:00:00Z"),
    fetch: async () => { throw new Error("cache should prevent network access"); },
  });
  assert.equal(cached.provenance, "session_cache");
  assert.equal(cached.accessToken, "cached-token");
  assert.equal(cached.user, null);

  const refreshed = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile,
    env: {},
    now: () => new Date("2031-01-01T00:00:00Z"),
    browserCookieProvider: async () => browserCandidate(validCookies()),
    fetch: exchangeResponse({
      auth_token: "new-access-token",
      auth_token_expiry: "2031-01-02T00:00:00Z",
      user: { username: "alice" },
    }),
  });
  assert.equal(refreshed.provenance, "browser");
  assert.equal(refreshed.accessToken, "new-access-token");
  if (process.platform !== "win32") assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
  const storedText = await readFile(sessionFile, "utf8");
  assert.equal(JSON.parse(storedText).access_token, "new-access-token");
  assert.doesNotMatch(storedText, /refresh-secret/u);
}

export async function test_explicit_and_cached_credentials_precede_browser_cookies(): Promise<void> {
  const directory = await temporaryDirectory();
  const sessionFile = join(directory, "session.json");
  let browserReads = 0;
  const explicit = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile,
    env: { ONTRACK_USERNAME: "alice", ONTRACK_TOKEN: "explicit-token" },
    browserCookieProvider: async () => { browserReads += 1; return []; },
  });
  assert.equal(explicit.provenance, "environment");
  assert.equal(browserReads, 0);

  await writeFile(sessionFile, JSON.stringify({
    base_url: "https://school.example.edu",
    username: "cached-user",
    access_token: "cached-token",
    auth_token_expiry: "2030-01-01T00:00:00.000Z",
    provenance: "browser",
  }));
  const cached = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile,
    env: {},
    now: () => new Date("2029-01-01T00:00:00Z"),
    browserCookieProvider: async () => { browserReads += 1; return []; },
  });
  assert.equal(cached.provenance, "session_cache");
  assert.equal(browserReads, 0);
}

export async function test_auth_login_reuses_browser_cookies_without_prompting(): Promise<void> {
  const directory = await temporaryDirectory();
  let prompted = false;
  let opened = false;
  const session = await loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    browserCookieProvider: async () => browserCandidate(validCookies()),
    promptEnter: async () => { prompted = true; },
    openBrowser: async () => { opened = true; },
    now: () => new Date("2029-01-01T00:00:00Z"),
    fetch: exchangeResponse({
      auth_token: "access-secret",
      auth_token_expiry: "2030-01-01T00:00:00Z",
      user: { username: "alice" },
    }),
  });
  assert.equal(session.provenance, "browser");
  assert.equal(prompted, false);
  assert.equal(opened, false);
}

export async function test_interactive_browser_login_completes_via_loopback_callback(): Promise<void> {
  const directory = await temporaryDirectory();
  const sessionFile = join(directory, "session.json");
  const events: string[] = [];
  let snippet = "";
  const session = await loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile,
    browserCookieProvider: async () => [],
    createState: () => "state-123",
    loopbackLoginListener: async ({ state, onListening }) => {
      events.push(`listen:${state}`);
      await onListening(45678);
      return { token: "access-secret", expiry: "2030-01-01T00:00:00Z", username: "alice" };
    },
    onLoginUrl: (url) => { events.push(`url:${url}`); },
    onConsoleSnippet: (value) => { snippet = value; events.push("snippet"); },
    onBrowserWait: (timeoutMs) => { events.push(`wait:${timeoutMs}`); },
    promptEnter: async () => { events.push("prompt"); },
    openBrowser: async (url) => { events.push(`open:${url}`); },
    loginTimeoutMs: 45_000,
    now: () => new Date("2029-01-01T00:00:00Z"),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      events.push(`${request.method}:${request.url}`);
      if (request.url.endsWith("/api/auth/method")) {
        return Response.json({ method: "saml", redirect_to: "https://identity.example.edu/ontrack/saml" });
      }
      throw new Error("no cookie exchange expected in loopback flow");
    },
  });

  assert.equal(session.provenance, "browser");
  assert.equal(session.username, "alice");
  assert.equal(session.accessToken, "access-secret");
  assert.match(snippet, /127\.0\.0\.1:45678\/cb/u);
  assert.match(snippet, /state-123/u);
  assert.match(snippet, /\/api\/auth\/access-token/u);
  assert.deepEqual(events, [
    "GET:https://school.example.edu/api/auth/method",
    "listen:state-123",
    "url:https://identity.example.edu/ontrack/saml",
    "snippet",
    "prompt",
    "open:https://identity.example.edu/ontrack/saml",
    "wait:45000",
  ]);

  const persisted = JSON.parse(await readFile(sessionFile, "utf8")) as Record<string, unknown>;
  assert.equal(persisted.access_token, "access-secret");
  assert.equal(persisted.provenance, "browser");
}

export async function test_loopback_listener_resolves_on_matching_state(): Promise<void> {
  const result = await nodeLoopbackListener({
    state: "s-1",
    timeoutMs: 5_000,
    signal: undefined,
    now: () => new Date("2029-01-01T00:00:00Z"),
    onListening: async (port) => {
      const bad = await fetch(`http://127.0.0.1:${port}/cb?state=wrong&token=t&expiry=2030-01-01T00:00:00Z&username=a`);
      assert.equal(bad.status, 204);
      const response = await fetch(`http://127.0.0.1:${port}/cb?state=s-1&token=tok&expiry=2030-01-01T00:00:00Z&username=alice`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      const body = await response.text();
      assert.match(body, /history\.replaceState/u);
      assert.match(body, /Signed in/u);
    },
  });
  assert.deepEqual(result, { token: "tok", expiry: "2030-01-01T00:00:00Z", username: "alice" });
}

export async function test_loopback_listener_rejects_expired_callback_before_success(): Promise<void> {
  const result = await nodeLoopbackListener({
    state: "s-expired",
    timeoutMs: 5_000,
    signal: undefined,
    now: () => new Date("2029-01-01T00:00:00Z"),
    onListening: async (port) => {
      const expired = await fetch(`http://127.0.0.1:${port}/cb?state=s-expired&token=old&expiry=2028-01-01T00:00:00Z&username=alice`);
      assert.equal(expired.status, 400);
      const expiredBody = await expired.text();
      assert.match(expiredBody, /history\.replaceState/u);
      assert.doesNotMatch(expiredBody, /Signed in/u);

      const valid = await fetch(`http://127.0.0.1:${port}/cb?state=s-expired&token=fresh&expiry=2030-01-01T00:00:00Z&username=alice`);
      assert.equal(valid.status, 200);
    },
  });
  assert.equal(result.token, "fresh");
}

export async function test_loopback_listener_rejects_incomplete_callback(): Promise<void> {
  const result = await nodeLoopbackListener({
    state: "s-2",
    timeoutMs: 5_000,
    signal: undefined,
    onListening: async (port) => {
      const incomplete = await fetch(`http://127.0.0.1:${port}/cb?state=s-2&token=&expiry=&username=`);
      assert.equal(incomplete.status, 400);
      await fetch(`http://127.0.0.1:${port}/cb?state=s-2&token=tok&expiry=2030-01-01T00:00:00Z&username=alice`);
    },
  });
  assert.equal(result.token, "tok");
}

export async function test_loopback_listener_times_out(): Promise<void> {
  await assert.rejects(nodeLoopbackListener({
    state: "s-3",
    timeoutMs: 10,
    signal: undefined,
    onListening: async () => {},
  }), (error) => error instanceof CliError && error.category === "auth" && /Timed out/u.test(error.message));
}

export async function test_loopback_listener_cancels_on_abort(): Promise<void> {
  const controller = new AbortController();
  await assert.rejects(nodeLoopbackListener({
    state: "s-4",
    timeoutMs: 5_000,
    signal: controller.signal,
    onListening: async () => { controller.abort(); },
  }), (error) => error instanceof CliError && error.category === "cancellation");
}

export async function test_browser_cookie_permission_error_stops_before_interactive_login(): Promise<void> {
  const directory = await temporaryDirectory();
  const permissionError = new CliError(
    "auth",
    "Chrome cookie access is disabled for this terminal.",
    undefined,
    "Enable Chrome in System Settings > Privacy & Security > Files & Folders, then retry.",
  );
  let requestedLoginUrl = false;
  let prompted = false;

  await assert.rejects(loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    browserCookieProvider: async () => { throw permissionError; },
    promptEnter: async () => { prompted = true; },
    openBrowser: async () => { throw new Error("must not open"); },
    fetch: async () => {
      requestedLoginUrl = true;
      throw new Error("must not fetch");
    },
  }), (error) => error === permissionError);

  assert.equal(requestedLoginUrl, false);
  assert.equal(prompted, false);
}

export async function test_interactive_browser_login_rejects_invalid_redirects_before_prompting(): Promise<void> {
  const directory = await temporaryDirectory();
  for (const payload of [
    { method: "saml", redirect_to: null },
    { method: "saml", redirect_to: "http://identity.example.edu/saml" },
  ]) {
    let prompted = false;
    await assert.rejects(loginAuthenticatedSession({
      baseUrl: "https://school.example.edu",
      sessionFile: join(directory, `${String(payload.redirect_to)}.json`),
      browserCookieProvider: async () => [],
      promptEnter: async () => { prompted = true; },
      openBrowser: async () => { throw new Error("must not open"); },
      fetch: async () => Response.json(payload),
    }), (error) => error instanceof CliError && error.category === "upstream_contract");
    assert.equal(prompted, false);
  }
}

export async function test_interactive_browser_login_reports_opener_failure_without_exposing_redirect(): Promise<void> {
  const directory = await temporaryDirectory();
  await assert.rejects(loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    browserCookieProvider: async () => [],
    loopbackLoginListener: async ({ onListening }) => {
      await onListening(0);
      return { token: "unused", expiry: "2030-01-01T00:00:00Z", username: "alice" };
    },
    promptEnter: async () => {},
    openBrowser: async () => { throw new Error("https://identity.example.edu/?SAMLRequest=secret"); },
    fetch: async () => Response.json({
      method: "saml",
      redirect_to: "https://identity.example.edu/?SAMLRequest=secret",
    }),
  }), (error) => error instanceof CliError
    && error.category === "auth"
    && error.message === "Could not open the OnTrack sign-in page in your browser."
    && !error.message.includes("SAMLRequest"));
}

export async function test_interactive_browser_login_rejects_expired_callback_token(): Promise<void> {
  const directory = await temporaryDirectory();
  const sessionFile = join(directory, "session.json");
  await assert.rejects(loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile,
    browserCookieProvider: async () => [],
    loopbackLoginListener: async ({ onListening }) => {
      await onListening(1);
      return { token: "stale", expiry: "2020-01-01T00:00:00Z", username: "alice" };
    },
    promptEnter: async () => {},
    openBrowser: async () => {},
    now: () => new Date("2029-01-01T00:00:00Z"),
    fetch: async () => Response.json({
      method: "saml",
      redirect_to: "https://identity.example.edu/ontrack/saml",
    }),
  }), (error) => error instanceof CliError
    && error.category === "auth"
    && /invalid or expired/u.test(error.message));

  await assert.rejects(stat(sessionFile), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
}

export async function test_interactive_browser_login_rechecks_callback_expiry_after_wait(): Promise<void> {
  const directory = await temporaryDirectory();
  const sessionFile = join(directory, "session.json");
  let now = new Date("2029-01-01T00:00:00Z");

  await assert.rejects(loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile,
    browserCookieProvider: async () => [],
    loopbackLoginListener: async ({ onListening }) => {
      await onListening(1);
      now = new Date("2029-01-01T00:02:00Z");
      return { token: "stale", expiry: "2029-01-01T00:01:00Z", username: "alice" };
    },
    promptEnter: async () => {},
    openBrowser: async () => {},
    now: () => now,
    fetch: async () => Response.json({
      method: "saml",
      redirect_to: "https://identity.example.edu/ontrack/saml",
    }),
  }), (error) => error instanceof CliError
    && error.category === "auth"
    && /invalid or expired/u.test(error.message));

  await assert.rejects(stat(sessionFile), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
}

export async function test_interactive_browser_login_can_be_cancelled_before_callback(): Promise<void> {
  const directory = await temporaryDirectory();
  const controller = new AbortController();
  await assert.rejects(loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    signal: controller.signal,
    browserCookieProvider: async () => [],
    loopbackLoginListener: (request) => nodeLoopbackListener(request),
    promptEnter: async () => {},
    openBrowser: async () => { controller.abort(); },
    fetch: async () => Response.json({
      method: "saml",
      redirect_to: "https://identity.example.edu/ontrack/saml",
    }),
  }), (error) => error instanceof CliError && error.category === "cancellation");
}

export async function test_normal_auth_without_browser_cookies_requires_explicit_login(): Promise<void> {
  const directory = await temporaryDirectory();
  let requests = 0;
  await assert.rejects(resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    browserCookieProvider: async () => [],
    fetch: async () => {
      requests += 1;
      throw new Error("normal commands must not start interactive authentication");
    },
  }), (error) => error instanceof CliError
    && error.category === "auth"
    && /ontrack auth login/u.test(error.message));
  assert.equal(requests, 0);
}

export async function test_null_access_token_response_is_cookie_exchange_failure(): Promise<void> {
  const directory = await temporaryDirectory();
  await assert.rejects(resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    browserCookieProvider: async () => browserCandidate(validCookies()),
    fetch: exchangeResponse(null),
  }), (error) => error instanceof CliError && error.category === "auth" && /ontrack auth login/u.test(error.message));
}

export async function test_cookie_exchange_surfaces_rate_limits_and_server_failures(): Promise<void> {
  const directory = await temporaryDirectory();
  for (const status of [429, 500]) {
    await assert.rejects(resolveAuthenticatedSession({
      baseUrl: "https://school.example.edu",
      sessionFile: join(directory, `${status}.json`),
      env: {},
      browserCookieProvider: async () => browserCandidate(validCookies()),
      fetch: async () => new Response(null, { status }),
    }), (error) => error instanceof CliError
      && error.category === "auth"
      && error.message.includes(`HTTP ${status}`));
  }
}

export async function test_cookie_exchange_has_its_own_timeout(): Promise<void> {
  const directory = await temporaryDirectory();
  await assert.rejects(resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    browserCookieProvider: async () => browserCandidate(validCookies()),
    exchangeTimeoutMs: 5,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  }), (error) => error instanceof CliError && error.category === "auth" && /timed out after 5ms/u.test(error.message));
}

export async function test_cookie_exchange_reports_session_cache_write_failure(): Promise<void> {
  const directory = await temporaryDirectory();
  await assert.rejects(resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: directory,
    env: {},
    skipCache: true,
    browserCookieProvider: async () => browserCandidate(validCookies()),
    fetch: exchangeResponse({
      auth_token: "access-secret",
      auth_token_expiry: "2030-01-01T00:00:00Z",
      user: { username: "alice" },
    }),
  }), (error) => error instanceof CliError && error.category === "auth" && /write the authenticated session cache/u.test(error.message));
}

export async function test_skip_cache_bypasses_a_rejected_unexpired_session(): Promise<void> {
  const directory = await temporaryDirectory();
  const sessionFile = join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({
    base_url: "https://school.example.edu",
    username: "rejected-user",
    access_token: "rejected-token",
    auth_token_expiry: "2030-01-01T00:00:00.000Z",
    provenance: "browser",
  }));
  const session = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile,
    env: {},
    now: () => new Date("2029-01-01T00:00:00Z"),
    skipCache: true,
    browserCookieProvider: async () => browserCandidate(validCookies()),
    fetch: exchangeResponse({
      auth_token: "replacement-token",
      auth_token_expiry: "2030-01-01T00:00:00Z",
      user: { id: 9, username: "alice", first_name: "Alice", authentication_token: "must-not-retain" },
    }),
  });
  assert.equal(session.accessToken, "replacement-token");
  assert.equal("authentication_token" in (session.user ?? {}), false);
}
