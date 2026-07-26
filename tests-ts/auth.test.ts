import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import {
  loginAuthenticatedSession,
  resolveAuthenticatedSession as resolveAuthenticatedSessionWithRuntime,
  type ResolveAuthenticatedSessionOptions,
} from "../src/auth.js";
import { loadConfig, resolveConfigPaths, resolveCredentialSource } from "../src/config.js";
import { CliError } from "../src/errors.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ontrack-auth-test-"));
}

function resolveAuthenticatedSession(
  options: Omit<ResolveAuthenticatedSessionOptions, "platform">,
) {
  return resolveAuthenticatedSessionWithRuntime({
    ...options,
    platform: process.platform,
  });
}

async function fakeOkta(directory: string, output: string | null, hang = false, failure?: string): Promise<void> {
  const shellBody = hang
    ? "sleep 5"
    : failure
      ? `printf '%s\\n' '${failure.replaceAll("'", "'\\''")}' >&2\nexit 1`
      : output === null ? ":" : `printf '%s' '${output.replaceAll("'", "'\\''")}'`;
  const cmdBody = hang
    ? "ping 127.0.0.1 -n 6 > nul"
    : failure ? `echo ${failure} 1>&2\r\nexit /b 1` : output === null ? "rem empty" : `echo ${output}`;
  const shell = `#!/bin/sh\n${shellBody}\n`;
  const cmd = `@echo off\r\n${cmdBody}\r\n`;
  await writeFile(join(directory, "okta"), shell, "utf8");
  await chmod(join(directory, "okta"), 0o755);
  await writeFile(join(directory, "okta.cmd"), cmd, "utf8");
}

function fakeOktaPath(directory: string): string {
  return join(directory, process.platform === "win32" ? "okta.cmd" : "okta");
}

async function fakeInteractiveOkta(directory: string, argumentsFile: string): Promise<string> {
  const cookies = JSON.stringify({ cookies: [
    { name: "refresh_token", value: "refresh-secret", domain: "school.example.edu", path: "/" },
  ] });
  const executable = join(directory, "interactive-okta");
  const shell = [
    "#!/bin/sh",
    "if [ \"$1\" = cookies ] && [ \"$3\" = https://school.example.edu ]; then echo 'No stored session' >&2; exit 1; fi",
    `printf '%s\\n' \"$*\" >> '${argumentsFile.replaceAll("'", "'\\''")}'`,
    `if [ \"$1\" = login ]; then printf '%s' 'Username: TOTP secret (optional): {"success":true}'; else printf '%s' '${cookies}'; fi`,
    "",
  ].join("\n");
  await writeFile(executable, shell, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

async function fakeRedirectOnlyOkta(directory: string, argumentsFile: string): Promise<string> {
  const cookies = JSON.stringify({ cookies: [
    { name: "refresh_token", value: "refresh-secret", domain: "school.example.edu", path: "/" },
  ] });
  const executable = join(directory, "redirect-only-okta");
  const shell = [
    "#!/bin/sh",
    `printf '%s\\n' \"$*\" >> '${argumentsFile.replaceAll("'", "'\\''")}'`,
    "if [ \"$3\" = https://school.example.edu ]; then echo 'No stored session' >&2; exit 1; fi",
    `printf '%s' '${cookies}'`,
    "",
  ].join("\n");
  await writeFile(executable, shell, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

async function fakeBrowserSessionOkta(directory: string, argumentsFile: string): Promise<string> {
  const cookies = JSON.stringify({ cookies: [
    { name: "username", value: "alice", domain: "school.example.edu", path: "/" },
    { name: "refresh_token", value: "refresh-secret", domain: "school.example.edu", path: "/api/auth" },
  ] });
  const executable = join(directory, "browser-session-okta");
  const shell = [
    "#!/bin/sh",
    `printf '%s\n' "$*" >> '${argumentsFile.replaceAll("'", "'\\''")}'`,
    "if [ \"$1\" = login ]; then echo 'unexpected interactive login' >&2; exit 1; fi",
    `printf '%s' '${cookies}'`,
    "",
  ].join("\n");
  await writeFile(executable, shell, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

async function fakeStaleBaseOkta(directory: string, argumentsFile: string): Promise<string> {
  const stale = JSON.stringify({ cookies: [
    { name: "TS-cookie", value: "stale", domain: "school.example.edu", path: "/" },
  ] });
  const fresh = JSON.stringify({ cookies: [
    { name: "username", value: "alice", domain: "school.example.edu", path: "/api/auth" },
    { name: "refresh_token", value: "refresh-secret", domain: "school.example.edu", path: "/api/auth" },
  ] });
  const executable = join(directory, "stale-base-okta");
  const shell = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${argumentsFile.replaceAll("'", "'\\''")}'`,
    `if [ "$3" = https://school.example.edu ]; then printf '%s' '${stale}'; else printf '%s' '${fresh}'; fi`,
    "",
  ].join("\n");
  await writeFile(executable, shell, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

function exchangeResponse(payload: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function test_config_paths_honor_explicit_xdg_and_platform_fallbacks(): void {
  assert.deepEqual(
    resolveConfigPaths({
      env: { ONTRACK_CONFIG: "/custom/ontrack.yaml", XDG_CONFIG_HOME: "/ignored" },
      platform: "linux",
      homeDir: "/home/alice",
      cwd: "/work",
    }),
    {
      configDir: "/custom",
      configFile: "/custom/ontrack.yaml",
      sessionFile: "/custom/session.json",
    },
  );
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
    ONTRACK_AUTH_TOKEN: "env-token",
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
  assert.deepEqual(resolveCredentialSource({}, config), {
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

export async function test_cookie_exchange_filters_inapplicable_cookies(): Promise<void> {
  const directory = await temporaryDirectory();
  await fakeOkta(directory, JSON.stringify({ cookies: [
    { name: "valid", value: "kept", domain: "school.example.edu", path: "/api", secure: true, expires: "2030-01-01T00:00:00Z" },
    { name: "parent-host-only", value: "dropped", domain: "example.edu", path: "/api", secure: true },
    { name: "wrong-path", value: "dropped", domain: "school.example.edu", path: "/account", secure: true },
    { name: "expired", value: "dropped", domain: "school.example.edu", path: "/", secure: true, expires: "2020-01-01T00:00:00Z" },
  ] }));
  let cookieHeader = "";
  await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    oktaExecutable: fakeOktaPath(directory),
    now: new Date("2029-01-01T00:00:00Z"),
    fetch: async (_input, init) => {
      cookieHeader = new Headers(init?.headers).get("Cookie") ?? "";
      return exchangeResponse({
        auth_token: "access-secret",
        auth_token_expiry: "2030-01-01T00:00:00Z",
        user: { username: "alice" },
      })(_input, init);
    },
  });
  assert.equal(cookieHeader, "valid=kept");

  await assert.rejects(resolveAuthenticatedSession({
    baseUrl: "http://school.example.edu",
    sessionFile: join(directory, "http", "session.json"),
    env: {},
    oktaExecutable: fakeOktaPath(directory),
    now: new Date("2029-01-01T00:00:00Z"),
    fetch: exchangeResponse(null),
  }), /no OnTrack cookies/i);
}

export async function test_valid_cached_session_is_reused_and_expired_session_is_replaced(): Promise<void> {
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
    sessionFile: join(directory, "session.json"),
    env: {},
    now: new Date("2029-01-01T00:00:00Z"),
    oktaExecutable: join(directory, "missing-okta"),
    fetch: exchangeResponse(null),
  });
  assert.equal(cached.provenance, "session_cache");
  assert.equal(cached.accessToken, "cached-token");
  assert.equal(cached.user, null);

  await fakeOkta(directory, '{"cookies":[{"name":"username","value":"okta-user","domain":"school.example.edu","path":"/"},{"name":"refresh_token","value":"refresh-secret","domain":"school.example.edu","path":"/"}]}');
  const refreshed = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    now: new Date("2031-01-01T00:00:00Z"),
    oktaExecutable: fakeOktaPath(directory),
    fetch: exchangeResponse({
      auth_token: "new-access-token",
      auth_token_expiry: "2031-01-02T00:00:00Z",
      user: { username: "okta-user" },
    }),
  });
  assert.equal(refreshed.provenance, "okta");
  assert.equal(refreshed.accessToken, "new-access-token");
  if (process.platform !== "win32") assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
  const storedText = await readFile(sessionFile, "utf8");
  assert.equal(JSON.parse(storedText).access_token, "new-access-token");
  assert.doesNotMatch(storedText, /refresh-secret/);
}

export async function test_adjacent_auth_sources_prefer_migration_over_cache_and_cache_over_okta(): Promise<void> {
  const directory = await temporaryDirectory();
  const sessionFile = join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({
    base_url: "https://school.example.edu",
    username: "cached-user",
    access_token: "cached-token",
    auth_token_expiry: "2030-01-01T00:00:00.000Z",
    provenance: "okta",
  }));
  await fakeOkta(directory, '{"cookies":[{"name":"refresh_token","value":"okta-secret","domain":"school.example.edu","path":"/"}]}');

  const migration = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile,
    env: { ONTRACK_DOUBTFIRE_USER_JSON: JSON.stringify({ username: "migration-user", authenticationToken: "migration-token" }) },
    now: new Date("2029-01-01T00:00:00Z"),
    oktaExecutable: fakeOktaPath(directory),
    fetch: async () => { throw new Error("lower-priority Okta provider must not run"); },
  });
  assert.equal(migration.provenance, "migration");
  assert.equal(migration.accessToken, "migration-token");

  const cached = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile,
    env: {},
    now: new Date("2029-01-01T00:00:00Z"),
    oktaExecutable: fakeOktaPath(directory),
    fetch: async () => { throw new Error("lower-priority Okta provider must not run"); },
  });
  assert.equal(cached.provenance, "session_cache");
  assert.equal(cached.accessToken, "cached-token");
}

export async function test_fake_okta_subprocess_success_uses_only_json_output(): Promise<void> {
  const directory = await temporaryDirectory();
  await fakeOkta(directory, '{"cookies":[{"name":"username","value":"alice","domain":"school.example.edu","path":"/"},{"name":"refresh_token","value":"refresh-secret","domain":"school.example.edu","path":"/"}]}');
  let request: Request | undefined;
  const session = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    oktaExecutable: fakeOktaPath(directory),
    fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      request = new Request(input, init);
      return exchangeResponse({
        auth_token: "access-secret",
        auth_token_expiry: "2030-01-01T00:00:00Z",
        user: { username: "alice" },
      })(input, init);
    },
    now: new Date("2029-01-01T00:00:00Z"),
  });
  assert.equal(session.username, "alice");
  assert.equal(session.provenance, "okta");
  assert.deepEqual(session.user, {
    id: null,
    username: "alice",
    first_name: null,
    last_name: null,
    email: null,
    nickname: null,
  });
  assert.equal(request?.method, "POST");
  assert.equal(new URL(request?.url ?? "").pathname, "/api/auth/access-token");
  assert.match(request?.headers.get("cookie") ?? "", /refresh_token=refresh-secret/);
}

export async function test_interactive_login_follows_ontrack_sign_in_redirect_before_cookie_exchange(): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await temporaryDirectory();
  const argumentsFile = join(directory, "arguments.txt");
  const executable = await fakeInteractiveOkta(directory, argumentsFile);
  const requests: Request[] = [];
  let prompts = "";
  const session = await loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: { ONTRACK_USERNAME: "must-not-short-circuit", ONTRACK_AUTH_TOKEN: "must-not-short-circuit" },
    platform: process.platform,
    oktaExecutable: executable,
    promptOutput: (text) => { prompts += text; },
    now: new Date("2029-01-01T00:00:00Z"),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url === "https://school.example.edu/api/auth/method") {
        return new Response(JSON.stringify({
          method: "saml",
          redirect_to: "https://monash.okta.com/app/ontrack/sso/saml",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return exchangeResponse({
        auth_token: "access-secret",
        auth_token_expiry: "2030-01-01T00:00:00Z",
        user: { username: "alice" },
      })(input, init);
    },
  });

  assert.equal(session.username, "alice");
  assert.equal(session.provenance, "okta");
  assert.equal(prompts, "Username: TOTP secret (optional): ");
  assert.deepEqual((await readFile(argumentsFile, "utf8")).trim().split("\n"), [
    "login --headed --timeout-ms 120000 --settle-ms 5000 --json https://monash.okta.com/app/ontrack/sso/saml",
    "cookies --json https://monash.okta.com/app/ontrack/sso/saml",
  ]);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
    "GET https://school.example.edu/api/auth/method",
    "POST https://school.example.edu/api/auth/access-token",
  ]);
  assert.match(requests[1]?.headers.get("cookie") ?? "", /refresh_token=refresh-secret/u);
  const stored = JSON.parse(await readFile(join(directory, "session.json"), "utf8")) as Record<string, unknown>;
  assert.equal(stored.access_token, "access-secret");
}

export async function test_auth_login_reuses_browser_cookies_without_starting_interactive_login(): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await temporaryDirectory();
  const argumentsFile = join(directory, "arguments.txt");
  const executable = await fakeBrowserSessionOkta(directory, argumentsFile);
  const requests: Request[] = [];
  const session = await loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    platform: process.platform,
    oktaExecutable: executable,
    now: new Date("2029-01-01T00:00:00Z"),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return exchangeResponse({
        auth_token: "access-secret",
        auth_token_expiry: "2030-01-01T00:00:00Z",
        user: { username: "alice" },
      })(input, init);
    },
  });

  assert.equal(session.username, "alice");
  assert.deepEqual((await readFile(argumentsFile, "utf8")).trim().split("\n"), [
    "cookies --json https://school.example.edu",
  ]);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
    "POST https://school.example.edu/api/auth/access-token",
  ]);
}

export async function test_auth_login_exchanges_default_browser_cookie_pair_before_okta(): Promise<void> {
  const directory = await temporaryDirectory();
  let request: Request | undefined;
  const session = await loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    platform: process.platform,
    oktaExecutable: join(directory, "must-not-run"),
    browserCookieProvider: async () => [{
      source: "Chrome:Default",
      cookies: [
        { name: "username", value: "alice", domain: "school.example.edu", path: "/api/auth" },
        { name: "refresh_token", value: "refresh-secret", domain: "school.example.edu", path: "/api/auth" },
      ],
    }],
    now: new Date("2029-01-01T00:00:00Z"),
    fetch: async (input, init) => {
      request = new Request(input, init);
      return exchangeResponse({
        auth_token: "access-secret",
        auth_token_expiry: "2030-01-01T00:00:00Z",
        user: { username: "alice" },
      })(input, init);
    },
  });

  assert.equal(session.provenance, "browser");
  assert.equal(request?.url, "https://school.example.edu/api/auth/access-token");
  assert.equal(request?.headers.get("cookie"), "username=alice; refresh_token=refresh-secret");
  const stored = JSON.parse(await readFile(join(directory, "session.json"), "utf8")) as Record<string, unknown>;
  assert.equal(stored.provenance, "browser");
  assert.equal(stored.access_token, "access-secret");
  assert.equal("refresh_token" in stored, false);
}

export async function test_interactive_login_rejects_missing_redirect_without_starting_okta(): Promise<void> {
  const directory = await temporaryDirectory();
  await assert.rejects(loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    platform: process.platform,
    oktaExecutable: join(directory, "must-not-run"),
    fetch: async () => new Response(JSON.stringify({ method: "saml", redirect_to: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  }), (error) => error instanceof CliError
    && error.category === "upstream_contract"
    && /no SAML sign-in URL/i.test(error.message));
}

export async function test_interactive_login_rejects_an_insecure_sign_in_redirect(): Promise<void> {
  const directory = await temporaryDirectory();
  await assert.rejects(loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    platform: process.platform,
    oktaExecutable: join(directory, "must-not-run"),
    fetch: async () => new Response(JSON.stringify({
      method: "saml",
      redirect_to: "http://identity.example.edu/saml",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  }), (error) => error instanceof CliError
    && error.category === "upstream_contract"
    && /sign-in URL is invalid/i.test(error.message));
}

export async function test_interactive_login_reports_provider_failure_without_exposing_output(): Promise<void> {
  const directory = await temporaryDirectory();
  await fakeOkta(directory, null, false, "private-provider-detail");
  await assert.rejects(loginAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    platform: process.platform,
    oktaExecutable: fakeOktaPath(directory),
    fetch: async () => new Response(JSON.stringify({
      method: "saml",
      redirect_to: "https://monash.okta.com/app/ontrack/sso/saml",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  }), (error) => error instanceof CliError
    && error.category === "auth"
    && error.message === "Okta login failed."
    && !error.message.includes("private-provider-detail"));
}

export async function test_normal_auth_reuses_a_session_keyed_by_the_discovered_sign_in_url(): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await temporaryDirectory();
  const argumentsFile = join(directory, "arguments.txt");
  const executable = await fakeRedirectOnlyOkta(directory, argumentsFile);
  const session = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    oktaExecutable: executable,
    now: new Date("2029-01-01T00:00:00Z"),
    fetch: async (input, init) => {
      if (new Request(input, init).url.endsWith("/api/auth/method")) {
        return new Response(JSON.stringify({
          method: "saml",
          redirect_to: "https://monash.okta.com/app/ontrack/sso/saml",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return exchangeResponse({
        auth_token: "access-secret",
        auth_token_expiry: "2030-01-01T00:00:00Z",
        user: { username: "alice" },
      })(input, init);
    },
  });

  assert.equal(session.username, "alice");
  assert.deepEqual((await readFile(argumentsFile, "utf8")).trim().split("\n"), [
    "cookies --json https://school.example.edu",
    "cookies --json https://monash.okta.com/app/ontrack/sso/saml",
  ]);
}

export async function test_normal_auth_falls_back_from_stale_base_cookies_to_the_saml_browser_session(): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await temporaryDirectory();
  const argumentsFile = join(directory, "arguments.txt");
  const executable = await fakeStaleBaseOkta(directory, argumentsFile);
  const requests: Request[] = [];
  const session = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    oktaExecutable: executable,
    now: new Date("2029-01-01T00:00:00Z"),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/api/auth/method")) {
        return new Response(JSON.stringify({
          method: "saml",
          redirect_to: "https://monash.okta.com/app/ontrack/sso/saml",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if ((request.headers.get("cookie") ?? "").includes("TS-cookie=stale")) {
        return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
      }
      return exchangeResponse({
        auth_token: "access-secret",
        auth_token_expiry: "2030-01-01T00:00:00Z",
        user: { username: "alice" },
      })(input, init);
    },
  });

  assert.equal(session.username, "alice");
  assert.deepEqual((await readFile(argumentsFile, "utf8")).trim().split("\n"), [
    "cookies --json https://school.example.edu",
    "cookies --json https://monash.okta.com/app/ontrack/sso/saml",
  ]);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
    "POST https://school.example.edu/api/auth/access-token",
    "GET https://school.example.edu/api/auth/method",
    "POST https://school.example.edu/api/auth/access-token",
  ]);
}

export async function test_okta_subprocess_uses_only_the_injected_platform_and_environment(): Promise<void> {
  const directory = await temporaryDirectory();
  const executableName = "ontrack-injected-okta-test";
  const output = '{"cookies":[{"name":"refresh_token","value":"refresh-secret","domain":"school.example.edu","path":"/"}]}';
  await writeFile(join(directory, executableName), `#!/bin/sh\nprintf '%s' '${output}'\n`, "utf8");
  await chmod(join(directory, executableName), 0o755);
  await writeFile(join(directory, `${executableName}.cmd`), `@echo off\r\necho ${output}\r\n`, "utf8");

  const session = await resolveAuthenticatedSessionWithRuntime({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}` },
    platform: process.platform,
    oktaExecutable: process.platform === "win32" ? `${executableName}.cmd` : executableName,
    now: new Date("2029-01-01T00:00:00Z"),
    fetch: exchangeResponse({
      auth_token: "access-secret",
      auth_token_expiry: "2030-01-01T00:00:00Z",
      user: { username: "alice" },
    }),
  });
  assert.equal(session.provenance, "okta");
}

async function expectAuthFailure(
  output: string | null | undefined,
  expected: RegExp,
  timeoutMs = 1_000,
  hang = false,
  failure?: string,
): Promise<void> {
  const directory = await temporaryDirectory();
  const executable = fakeOktaPath(directory);
  if (output !== undefined) await fakeOkta(directory, output, hang, failure);
  await assert.rejects(
    resolveAuthenticatedSession({
      baseUrl: "https://school.example.edu",
      sessionFile: join(directory, "session.json"),
      env: {},
      oktaExecutable: executable,
      oktaTimeoutMs: timeoutMs,
      fetch: exchangeResponse(null),
    }),
    (error) => error instanceof CliError && error.category === "auth" && expected.test(error.message),
  );
}

export async function test_fake_okta_subprocess_reports_every_provider_failure_mode(): Promise<void> {
  await expectAuthFailure("not-json", /malformed JSON/i);
  await expectAuthFailure(null, /empty output/i);
  await expectAuthFailure(undefined, /unavailable/i);
  await expectAuthFailure(null, /timed out/i, 20, true);
  await expectAuthFailure(null, /no stored Okta session/i, 1_000, false, "No stored session");
  await expectAuthFailure(null, /Okta provider failed/i, 1_000, false, "Login failed");
}

export async function test_null_access_token_response_is_cookie_exchange_failure(): Promise<void> {
  const directory = await temporaryDirectory();
  await fakeOkta(directory, '{"cookies":[{"name":"refresh_token","value":"secret","domain":"school.example.edu","path":"/"}]}');
  await assert.rejects(
    resolveAuthenticatedSession({
      baseUrl: "https://school.example.edu",
      sessionFile: join(directory, "session.json"),
      env: {},
      oktaExecutable: fakeOktaPath(directory),
      fetch: exchangeResponse(null),
    }),
    (error) => error instanceof CliError && error.category === "auth" && /cookie exchange failed/i.test(error.message),
  );
}

export async function test_abort_cancels_okta_and_cookie_exchange(): Promise<void> {
  const directory = await temporaryDirectory();
  await fakeOkta(directory, null, true);
  const oktaController = new AbortController();
  const waitingForOkta = resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    oktaExecutable: fakeOktaPath(directory),
    signal: oktaController.signal,
  });
  oktaController.abort();
  await assert.rejects(waitingForOkta, (error) => error instanceof CliError && error.category === "cancellation");

  await fakeOkta(directory, '{"cookies":[{"name":"refresh_token","value":"secret","domain":"school.example.edu","path":"/"}]}');
  const exchangeController = new AbortController();
  const waitingForExchange = resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    oktaExecutable: fakeOktaPath(directory),
    signal: exchangeController.signal,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  exchangeController.abort();
  await assert.rejects(waitingForExchange, (error) => error instanceof CliError && error.category === "cancellation");
}

export async function test_cookie_exchange_has_its_own_timeout(): Promise<void> {
  const directory = await temporaryDirectory();
  await fakeOkta(directory, '{"cookies":[{"name":"refresh_token","value":"secret","domain":"school.example.edu","path":"/"}]}');
  await assert.rejects(resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    oktaExecutable: fakeOktaPath(directory),
    exchangeTimeoutMs: 5,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }),
  }), (error) => error instanceof CliError && error.category === "auth" && /exchange timed out/i.test(error.message));
}

export async function test_skip_cache_bypasses_a_rejected_unexpired_session(): Promise<void> {
  const directory = await temporaryDirectory();
  await writeFile(join(directory, "session.json"), JSON.stringify({
    base_url: "https://school.example.edu",
    username: "rejected-user",
    access_token: "rejected-token",
    auth_token_expiry: "2030-01-01T00:00:00.000Z",
    provenance: "okta",
  }));
  await fakeOkta(directory, '{"cookies":[{"name":"refresh_token","value":"secret","domain":"school.example.edu","path":"/"}]}');

  const session = await resolveAuthenticatedSession({
    baseUrl: "https://school.example.edu",
    sessionFile: join(directory, "session.json"),
    env: {},
    now: new Date("2029-01-01T00:00:00Z"),
    oktaExecutable: fakeOktaPath(directory),
    skipCache: true,
    fetch: exchangeResponse({
      auth_token: "replacement-token",
      auth_token_expiry: "2030-01-01T00:00:00Z",
      user: { id: 9, username: "alice", first_name: "Alice", authentication_token: "must-not-retain" },
    }),
  });

  assert.equal(session.accessToken, "replacement-token");
  assert.deepEqual(session.user, {
    id: 9,
    username: "alice",
    first_name: "Alice",
    last_name: null,
    email: null,
    nickname: null,
  });
  assert.equal("authentication_token" in (session.user ?? {}), false);
}
