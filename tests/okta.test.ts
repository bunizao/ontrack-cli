import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OktaSignInError } from "okta-auth-cli";

import {
  localAuthStatus,
  loginAuthenticatedSession,
  resolveAuthenticatedSession,
  type LoginAuthenticatedSessionOptions,
  type ResolveAuthenticatedSessionOptions,
} from "../src/auth.js";
import { CliError } from "../src/errors.js";
import { exportOktaCredentials, parseOktaExport } from "../src/okta-export.js";
import { attemptOktaSignIn, MAX_TRANSIENT_FAILURES, type OktaState } from "../src/okta-renewal.js";
import { signInToOnTrack } from "../src/okta-sign-in.js";
import { readSessionCache, writeSessionCache } from "../src/session-cache.js";
import {
  AUTH_TOKEN, BASE_URL, CREDENTIALS, fakeOkta, ONTRACK, ONTRACK_USER, PASSWORD, TOTP_SECRET, type RecordedRequest,
} from "./fake-okta.js";

const NOW = Date.parse("2026-11-09T10:00:00Z");
const HOUR = 60 * 60 * 1_000;
const cacheOptions = { encryptionKey: async () => Buffer.alloc(32, 17) };

async function sessionFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "ontrack-okta-test-")), "session.json");
}

function sentPassword(requests: readonly RecordedRequest[]): boolean {
  return requests.some((request) => request.body.includes(PASSWORD));
}

function assertNoSecrets(text: string): void {
  for (const secret of [PASSWORD, TOTP_SECRET, AUTH_TOKEN, "authToken=", "refresh-"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
}

export async function test_okta_sign_in_exchanges_the_one_time_token_for_a_remembered_session(): Promise<void> {
  const fake = fakeOkta({ now: () => NOW });
  const progress: string[] = [];
  const session = await signInToOnTrack({
    baseUrl: BASE_URL, credentials: CREDENTIALS, fetch: fake.fetch, now: () => NOW, onProgress: (message) => progress.push(message),
  });
  assert.equal(session.username, ONTRACK_USER);
  assert.equal(session.accessToken, "access-1");
  assert.deepEqual(session.renewalCookies.map((cookie) => [cookie.name, cookie.domain, cookie.path]), [
    ["refresh_token", ONTRACK, "/api/auth"], ["username", ONTRACK, "/api/auth"],
  ]);
  assert.equal(session.refreshExpiresAt?.valueOf(), Math.floor((NOW + 7 * 24 * HOUR) / 1_000) * 1_000);
  assert.equal(session.deviceToken, "dt-1");
  assert.ok(session.oktaSession.some((cookie) => cookie.name === "sid"));
  const exchange = fake.requests.find((request) => request.method === "POST" && request.url.pathname === "/api/auth");
  assert.deepEqual(JSON.parse(exchange!.body), { username: ONTRACK_USER, auth_token: AUTH_TOKEN, remember: true });
  assertNoSecrets(progress.join("\n"));
}

export async function test_okta_sign_in_without_a_one_time_token_fails_without_naming_the_query(): Promise<void> {
  const fake = fakeOkta({ now: () => NOW, noAuthToken: true });
  const error = await signInToOnTrack({ baseUrl: BASE_URL, credentials: CREDENTIALS, fetch: fake.fetch, now: () => NOW })
    .then(() => assert.fail("expected a failure"), (caught: unknown) => caught);
  assert.ok(error instanceof OktaSignInError);
  assert.equal(error.code, "handoff_failed");
  assert.ok(!error.message.includes("error=1"));
}

export async function test_okta_attempt_blocks_on_a_rejected_password_until_the_credentials_change(): Promise<void> {
  // Okta checks the TOTP code against the same clock the attempts use.
  let clock = NOW;
  const fake = fakeOkta({ now: () => clock });
  const wrong = { ...CREDENTIALS, password: "wrong" };
  const first = await attemptOktaSignIn({ baseUrl: BASE_URL, credentials: wrong, state: undefined, fetch: fake.fetch, now: () => NOW });
  assert.equal(first.outcome, "failed");
  assert.equal(first.state.blocked, "credentials_rejected");
  // The rejection still reached Okta, which named this device.
  assert.equal(first.state.device_token, "dt-1");

  clock = NOW + 24 * HOUR;
  const sent = fake.requests.length;
  const later = await attemptOktaSignIn({ baseUrl: BASE_URL, credentials: wrong, state: first.state, fetch: fake.fetch, now: () => NOW + 24 * HOUR });
  assert.equal(later.outcome, "waiting");
  assert.equal(fake.requests.length, sent, "a blocked attempt sends nothing");

  const fixed = await attemptOktaSignIn({ baseUrl: BASE_URL, credentials: CREDENTIALS, state: first.state, fetch: fake.fetch, now: () => NOW + 24 * HOUR });
  assert.equal(fixed.outcome, "signed_in");
  assert.equal(fixed.state.blocked, undefined);
  // The device token from the failure was sent back, so Okta minted no new one.
  assert.equal(fixed.state.device_token, "dt-1");
}

export async function test_okta_attempt_blocks_on_unsupported_mfa(): Promise<void> {
  const fake = fakeOkta({ now: () => NOW, factor: "phone_number" });
  const attempt = await attemptOktaSignIn({ baseUrl: BASE_URL, credentials: CREDENTIALS, state: undefined, fetch: fake.fetch, now: () => NOW });
  assert.equal(attempt.state.blocked, "mfa_unsupported");
}

export async function test_okta_attempt_backs_off_and_stops_after_repeated_network_failures(): Promise<void> {
  const fake = fakeOkta({ now: () => NOW, offline: true });
  let now = NOW;
  let state: OktaState | undefined;
  const delays: number[] = [];
  for (let attempt = 1; attempt <= MAX_TRANSIENT_FAILURES; attempt += 1) {
    const result = await attemptOktaSignIn({ baseUrl: BASE_URL, credentials: CREDENTIALS, state, fetch: fake.fetch, now: () => now });
    assert.equal(result.outcome, "failed");
    state = result.state;
    if (state.next_attempt_at !== undefined) {
      delays.push(state.next_attempt_at - now);
      const early = await attemptOktaSignIn({ baseUrl: BASE_URL, credentials: CREDENTIALS, state, fetch: fake.fetch, now: () => now + 1 });
      assert.equal(early.outcome, "waiting");
      now = state.next_attempt_at;
    }
  }
  assert.deepEqual(delays, [60_000, 120_000, 240_000, 480_000]);
  assert.equal(state?.blocked, "retries_exhausted");
}

export async function test_okta_attempt_refuses_a_different_account_and_reuses_the_okta_session(): Promise<void> {
  const fake = fakeOkta({ now: () => NOW });
  const first = await attemptOktaSignIn({ baseUrl: BASE_URL, credentials: CREDENTIALS, state: undefined, fetch: fake.fetch, now: () => NOW });
  assert.equal(first.outcome, "signed_in");

  const before = fake.requests.length;
  const second = await attemptOktaSignIn({
    baseUrl: BASE_URL, credentials: CREDENTIALS, state: first.state, expectedUsername: "someone-else", fetch: fake.fetch, now: () => NOW + 2 * 60_000,
  });
  assert.equal(second.outcome, "failed");
  assert.equal(second.state.blocked, "account_mismatch");
  assert.ok(!sentPassword(fake.requests.slice(before)), "the Okta session skipped the password");
}

export async function test_okta_attempt_explicit_lifts_a_block(): Promise<void> {
  const fake = fakeOkta({ now: () => NOW });
  const blocked: OktaState = { secrets: "x", failures: 0, blocked: "retries_exhausted" };
  const stale = await attemptOktaSignIn({ baseUrl: BASE_URL, credentials: CREDENTIALS, state: blocked, fetch: fake.fetch, now: () => NOW });
  assert.equal(stale.outcome, "signed_in", "a digest from other credentials starts over");
  const held = await attemptOktaSignIn({ baseUrl: BASE_URL, credentials: CREDENTIALS, state: { ...stale.state, blocked: "passcode_rejected" }, fetch: fake.fetch, now: () => NOW });
  assert.equal(held.outcome, "waiting");
  const explicit = await attemptOktaSignIn({
    baseUrl: BASE_URL, credentials: CREDENTIALS, state: { ...stale.state, blocked: "passcode_rejected" }, explicit: true, fetch: fake.fetch, now: () => NOW,
  });
  assert.equal(explicit.outcome, "signed_in");
}

function loginOptions(file: string, fetch: typeof globalThis.fetch, now: number, extra: Partial<LoginAuthenticatedSessionOptions> = {}): LoginAuthenticatedSessionOptions {
  return {
    ...cacheOptions, baseUrl: BASE_URL, sessionFile: file, mode: "okta", fetch, now: () => new Date(now),
    oktaCredentials: async () => CREDENTIALS, ...extra,
  };
}

function resolveOptions(file: string, fetch: typeof globalThis.fetch, now: number, extra: Partial<ResolveAuthenticatedSessionOptions> = {}): ResolveAuthenticatedSessionOptions {
  return { ...cacheOptions, baseUrl: BASE_URL, sessionFile: file, env: {}, fetch, now: () => new Date(now), oktaCredentials: async () => CREDENTIALS, ...extra };
}

async function stored(file: string): Promise<Record<string, any>> {
  return (await readSessionCache(file, cacheOptions))?.value as Record<string, any>;
}

export async function test_auth_login_okta_saves_the_refresh_cookie_and_okta_state(): Promise<void> {
  const file = await sessionFile();
  const fake = fakeOkta({ now: () => NOW });
  const session = await loginAuthenticatedSession(loginOptions(file, fake.fetch, NOW));
  assert.equal(session.username, ONTRACK_USER);
  assert.equal(session.provenance, "okta");
  const cache = await stored(file);
  assert.equal(cache.provenance, "okta");
  assert.ok(cache.refresh_cookies.some((cookie: { name: string }) => cookie.name === "refresh_token"));
  assert.equal(cache.okta.device_token, "dt-1");
  assert.equal(cache.okta.failures, 0);
  assert.ok(!JSON.stringify(cache).includes(PASSWORD), "the password is never cached");
  const status = await localAuthStatus(resolveOptions(file, fake.fetch, NOW));
  assert.equal(status.renewal, "okta");
  assert.equal(status.okta_blocked, null);
}

export async function test_auth_login_okta_refuses_a_different_cached_account(): Promise<void> {
  const file = await sessionFile();
  await loginAuthenticatedSession(loginOptions(file, fakeOkta({ now: () => NOW }).fetch, NOW));
  const other = fakeOkta({ now: () => NOW + 2 * 60_000, ontrackUser: "other0002" });
  const error = await loginAuthenticatedSession(loginOptions(file, other.fetch, NOW + 2 * 60_000))
    .then(() => assert.fail("expected a refusal"), (caught: unknown) => caught);
  assert.ok(error instanceof CliError);
  assert.equal(error.category, "auth");
  assert.match(error.hint ?? "", /auth logout/);
  assert.equal((await stored(file)).username, ONTRACK_USER);
}

export async function test_auth_login_okta_reports_a_rejected_password_without_secrets(): Promise<void> {
  const file = await sessionFile();
  const fake = fakeOkta({ now: () => NOW });
  const error = await loginAuthenticatedSession(loginOptions(file, fake.fetch, NOW, { oktaCredentials: async () => ({ ...CREDENTIALS, password: "wrong" }) }))
    .then(() => assert.fail("expected a refusal"), (caught: unknown) => caught);
  assert.ok(error instanceof CliError);
  assert.match(error.message, /rejected the username or password/);
  assertNoSecrets(`${error.message}\n${error.hint}`);
}

export async function test_renewal_signs_in_through_okta_when_the_refresh_cookie_has_under_48_hours(): Promise<void> {
  const file = await sessionFile();
  await loginAuthenticatedSession(loginOptions(file, fakeOkta({ now: () => NOW }).fetch, NOW));

  // Four days later the access token has expired and the refresh cookie has three days left: plain renewal.
  const fourDays = NOW + 4 * 24 * HOUR;
  const quiet = fakeOkta({ now: () => fourDays });
  let exports = 0;
  const renewed = await resolveAuthenticatedSession(resolveOptions(file, quiet.fetch, fourDays, { oktaCredentials: async () => { exports += 1; return CREDENTIALS; } }));
  assert.equal(renewed.username, ONTRACK_USER);
  assert.equal(exports, 0, "okta export is not run while the refresh cookie has time left");
  assert.ok(!quiet.requests.some((request) => request.url.hostname !== ONTRACK));

  // Six days in, under 48 hours remain: Okta signs in again and a new seven-day cookie replaces the old one.
  const sixDays = NOW + 6 * 24 * HOUR;
  const fake = fakeOkta({ now: () => sixDays });
  const announced: string[] = [];
  const session = await resolveAuthenticatedSession(resolveOptions(file, fake.fetch, sixDays, { onRenewing: (method) => announced.push(method) }));
  assert.equal(session.provenance, "okta");
  assert.deepEqual(announced, ["Okta"]);
  const refresh = (await stored(file)).refresh_cookies.find((cookie: { name: string }) => cookie.name === "refresh_token");
  assert.equal(refresh.expires, Math.floor((sixDays + 7 * 24 * HOUR) / 1_000));
}

export async function test_renewal_signs_in_through_okta_when_the_refresh_cookie_is_gone(): Promise<void> {
  const file = await sessionFile();
  await loginAuthenticatedSession(loginOptions(file, fakeOkta({ now: () => NOW }).fetch, NOW));
  const cache = await stored(file);
  const { refresh_cookies: _gone, ...rest } = cache;
  await writeSessionCache(file, { ...rest, auth_token_expiry: new Date(NOW).toISOString() }, cacheOptions);
  const later = NOW + HOUR;
  const session = await resolveAuthenticatedSession(resolveOptions(file, fakeOkta({ now: () => later }).fetch, later));
  assert.equal(session.provenance, "okta");
}

export async function test_renewal_never_repeats_a_rejected_password(): Promise<void> {
  const file = await sessionFile();
  await loginAuthenticatedSession(loginOptions(file, fakeOkta({ now: () => NOW }).fetch, NOW));
  const sixDays = NOW + 6 * 24 * HOUR;
  const wrong = async () => ({ ...CREDENTIALS, password: "changed-upstream" });
  // The refresh cookie still works, so the command succeeds while Okta's refusal is remembered.
  const first = fakeOkta({ now: () => sixDays });
  const session = await resolveAuthenticatedSession(resolveOptions(file, first.fetch, sixDays, { oktaCredentials: wrong }));
  assert.equal(session.username, ONTRACK_USER);
  assert.equal((await stored(file)).okta.blocked, "credentials_rejected");

  // Later commands neither read the password store nor contact Okta.
  const later = sixDays + HOUR;
  const second = fakeOkta({ now: () => later });
  let exports = 0;
  await resolveAuthenticatedSession(resolveOptions(file, second.fetch, later, { oktaCredentials: async () => { exports += 1; return CREDENTIALS; } }));
  assert.equal(exports, 0);
  assert.ok(!second.requests.some((request) => request.url.hostname !== ONTRACK));

  // Once the refresh cookie lapses, the error says why and how to recover.
  const lapsed = NOW + 8 * 24 * HOUR;
  const error = await resolveAuthenticatedSession(resolveOptions(file, fakeOkta({ now: () => lapsed }).fetch, lapsed))
    .then(() => assert.fail("expected a refusal"), (caught: unknown) => caught);
  assert.ok(error instanceof CliError);
  assert.match(error.message, /rejected the username or password/);
  assert.match(error.hint ?? "", /auth login --okta/);
  assert.equal((await localAuthStatus(resolveOptions(file, first.fetch, lapsed))).okta_blocked, "credentials_rejected");
}

export async function test_renewal_without_okta_never_runs_okta_export(): Promise<void> {
  const file = await sessionFile();
  await loginAuthenticatedSession(loginOptions(file, fakeOkta({ now: () => NOW }).fetch, NOW));
  const { okta: _okta, ...browserOnly } = await stored(file);
  await writeSessionCache(file, { ...browserOnly, provenance: "browser" }, cacheOptions);
  const sixDays = NOW + 6 * 24 * HOUR;
  let exports = 0;
  await resolveAuthenticatedSession(resolveOptions(file, fakeOkta({ now: () => sixDays }).fetch, sixDays, { oktaCredentials: async () => { exports += 1; return CREDENTIALS; } }));
  assert.equal(exports, 0);
}

export function test_okta_export_parsing_needs_all_three_values(): void {
  assert.deepEqual(parseOktaExport(JSON.stringify({ OKTA_USERNAME: " a@b ", OKTA_PASSWORD: "p w", OKTA_TOTP_SECRET: "JBSW" })),
    { username: "a@b", password: "p w", totpSecret: "JBSW" });
  assert.equal(parseOktaExport(JSON.stringify({ OKTA_USERNAME: "a", OKTA_PASSWORD: "p" })), null);
  assert.equal(parseOktaExport("not json"), null);
}

export async function test_okta_export_from_python_okta_before_0_3_asks_for_an_upgrade_and_skips_okta_auth(): Promise<void> {
  // Python okta-auth-cli 0.2.x: `okta` has no export subcommand, argparse exits 1,
  // and its `okta-auth` is the MCP server, which must not be started.
  const bin = await mkdtemp(join(tmpdir(), "ontrack-okta-bin-"));
  const marker = join(bin, "okta-auth-ran");
  if (process.platform === "win32") {
    await writeFile(join(bin, "okta.cmd"), "@echo usage: okta [-h] {login,check} 1>&2\r\n@exit /b 1\r\n");
    await writeFile(join(bin, "okta-auth.cmd"), `@type nul > "${marker}"\r\n`);
  } else {
    await writeFile(join(bin, "okta"), "#!/bin/sh\necho 'usage: okta [-h] {login,check}' >&2\nexit 1\n", { mode: 0o755 });
    await writeFile(join(bin, "okta-auth"), `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o755 });
  }
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    const error = await exportOktaCredentials().then(() => assert.fail("expected a failure"), (caught: unknown) => caught);
    assert.ok(error instanceof CliError);
    assert.match(error.hint ?? "", /okta-auth-cli 0\.3\.0 or later/);
    assert.match(error.hint ?? "", /uv tool upgrade okta-auth-cli/);
    await assert.rejects(stat(marker), "okta-auth must not run after okta failed");
  } finally {
    process.env.PATH = path;
  }
}

export async function test_renewal_falls_back_to_okta_in_the_same_command_when_the_refresh_cookie_is_refused(): Promise<void> {
  const file = await sessionFile();
  await loginAuthenticatedSession(loginOptions(file, fakeOkta({ now: () => NOW }).fetch, NOW));
  // Five days left, so Okta is not due until Doubtfire refuses the cookie.
  const later = NOW + 2 * 24 * HOUR;
  const fake = fakeOkta({ now: () => later, refuseRefresh: true });
  const session = await resolveAuthenticatedSession(resolveOptions(file, fake.fetch, later));
  assert.equal(session.provenance, "okta");
  assert.ok((await stored(file)).refresh_cookies.some((cookie: { name: string }) => cookie.name === "refresh_token"));
}

export async function test_cancelling_an_okta_sign_in_exits_as_cancelled_and_records_nothing(): Promise<void> {
  const file = await sessionFile();
  await loginAuthenticatedSession(loginOptions(file, fakeOkta({ now: () => NOW }).fetch, NOW));
  const before = (await stored(file)).okta;

  const sixDays = NOW + 6 * 24 * HOUR;
  const controller = new AbortController();
  const fake = fakeOkta({ now: () => sixDays });
  const error = await resolveAuthenticatedSession(resolveOptions(file, fake.fetch, sixDays, {
    signal: controller.signal,
    onOktaProgress: (message) => { if (message.startsWith("Exchanging")) controller.abort(); },
  })).then(() => assert.fail("expected a cancellation"), (caught: unknown) => caught);
  assert.ok(error instanceof CliError);
  assert.equal(error.category, "cancellation");
  assert.ok(!fake.requests.some((request) => request.method === "POST" && request.url.pathname === "/api/auth"), "the one-time token is never spent");
  const after = (await stored(file)).okta;
  assert.equal(after.failures, before.failures);
  assert.equal(after.blocked, undefined);
}
