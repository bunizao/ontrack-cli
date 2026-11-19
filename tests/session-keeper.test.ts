import assert from "node:assert/strict";

import { CliError } from "../src/errors.js";
import { SessionKeeper, type KeeperRecord, type KeeperStorage } from "../src/session-keeper.js";
import { BASE_URL, CREDENTIALS, fakeOkta, OKTA, ONTRACK, ONTRACK_USER, PASSWORD } from "./fake-okta.js";

const NOW = Date.parse("2026-11-09T10:00:00Z");
const HOUR = 60 * 60 * 1_000;
const WEEK = 7 * 24 * HOUR;

function memoryStorage(initial?: KeeperRecord): KeeperStorage & { record: KeeperRecord | undefined; alarm: number | null } {
  return {
    record: initial,
    alarm: null,
    async read() { return this.record; },
    async write(record) { this.record = structuredClone(record); },
    async setAlarm(at) { this.alarm = at; },
  };
}

function keeper(storage: KeeperStorage, fetch: typeof globalThis.fetch, now: () => number, okta = true): SessionKeeper {
  return new SessionKeeper({ baseUrl: BASE_URL, storage, okta: okta ? CREDENTIALS : null, fetch, now });
}

function refreshCookie(storage: { record: KeeperRecord | undefined }) {
  return storage.record?.session?.refresh_cookies.find((cookie) => cookie.name === "refresh_token");
}

export async function test_keeper_signs_in_through_okta_once_and_schedules_renewal_48_hours_ahead(): Promise<void> {
  const storage = memoryStorage();
  const fake = fakeOkta({ now: () => NOW });
  const subject = keeper(storage, fake.fetch, () => NOW);
  const [first, second] = await Promise.all([subject.credentials(), subject.credentials()]);
  assert.equal(first.username, ONTRACK_USER);
  assert.equal(second.accessToken, first.accessToken);
  assert.equal(fake.requests.filter((request) => request.body.includes(PASSWORD)).length, 1, "concurrent callers share one sign-in");
  const refresh = refreshCookie(storage)!;
  assert.equal(storage.alarm, refresh.expires! * 1_000 - 48 * HOUR);

  const before = fake.requests.length;
  await subject.credentials();
  assert.equal(fake.requests.length, before, "a fresh access token needs no request");
}

export async function test_keeper_mints_access_tokens_from_the_refresh_cookie_without_okta(): Promise<void> {
  const storage = memoryStorage();
  await keeper(storage, fakeOkta({ now: () => NOW }).fetch, () => NOW).credentials();
  const later = NOW + 2 * HOUR;
  const fake = fakeOkta({ now: () => later });
  const renewed = await keeper(storage, fake.fetch, () => later).credentials();
  assert.equal(renewed.username, ONTRACK_USER);
  assert.ok(fake.requests.every((request) => request.url.hostname === ONTRACK), "no Okta request");
  assert.deepEqual(fake.requests.map((request) => request.url.pathname), ["/api/auth/access-token"]);
}

export async function test_keeper_renews_a_token_ontrack_rejected_even_before_it_expires(): Promise<void> {
  const storage = memoryStorage();
  const first = await keeper(storage, fakeOkta({ now: () => NOW }).fetch, () => NOW).credentials();
  const fake = fakeOkta({ now: () => NOW });
  const renewed = await keeper(storage, fake.fetch, () => NOW).credentials(first.accessToken);
  assert.equal(renewed.username, ONTRACK_USER);
  assert.deepEqual(fake.requests.map((request) => request.url.pathname), ["/api/auth/access-token"]);
}

export async function test_keeper_falls_back_to_okta_when_the_refresh_cookie_is_refused(): Promise<void> {
  const storage = memoryStorage();
  await keeper(storage, fakeOkta({ now: () => NOW }).fetch, () => NOW).credentials();
  const later = NOW + 2 * HOUR;
  const fake = fakeOkta({ now: () => later, refuseRefresh: true });
  const renewed = await keeper(storage, fake.fetch, () => later).credentials();
  assert.equal(renewed.username, ONTRACK_USER);
  // The stored Okta session lets Okta skip the password; the sign-in still goes through Okta.
  assert.ok(fake.requests.some((request) => request.url.hostname === OKTA));
  assert.ok(fake.requests.some((request) => request.method === "POST" && request.url.pathname === "/api/auth"));
}

export async function test_keeper_alarm_revokes_and_replaces_a_lapsing_refresh_cookie(): Promise<void> {
  const storage = memoryStorage();
  await keeper(storage, fakeOkta({ now: () => NOW }).fetch, () => NOW).credentials();
  const held = refreshCookie(storage)!;
  const sixDays = NOW + 6 * 24 * HOUR;
  const fake = fakeOkta({ now: () => sixDays, heldRefresh: { value: held.value, expires: held.expires! } });
  await keeper(storage, fake.fetch, () => sixDays).alarm();
  const revoke = fake.requests.findIndex((request) => request.method === "DELETE" && request.url.pathname === "/api/auth");
  const exchange = fake.requests.findIndex((request) => request.method === "POST" && request.url.pathname === "/api/auth");
  assert.ok(revoke >= 0 && revoke < exchange, "the held token is revoked right before the exchange");
  assert.ok(fake.destroyed.has(held.value));
  const replaced = refreshCookie(storage)!;
  assert.equal(replaced.expires, Math.floor((sixDays + WEEK) / 1_000));
  assert.equal(storage.alarm, replaced.expires! * 1_000 - 48 * HOUR);
}

export async function test_keeper_alarm_does_nothing_while_the_refresh_cookie_has_time_left(): Promise<void> {
  const storage = memoryStorage();
  await keeper(storage, fakeOkta({ now: () => NOW }).fetch, () => NOW).credentials();
  const fake = fakeOkta({ now: () => NOW + HOUR });
  await keeper(storage, fake.fetch, () => NOW + HOUR).alarm();
  assert.equal(fake.requests.length, 0);
  assert.equal(storage.alarm, refreshCookie(storage)!.expires! * 1_000 - 48 * HOUR);
}

export async function test_keeper_without_okta_says_how_to_add_it_and_schedules_nothing(): Promise<void> {
  const storage = memoryStorage();
  const fake = fakeOkta({ now: () => NOW });
  await assert.rejects(keeper(storage, fake.fetch, () => NOW, false).credentials(),
    (error: unknown) => error instanceof CliError && error.category === "auth" && /--okta/u.test(error.hint ?? ""));
  assert.equal(fake.requests.length, 0);
  assert.equal(storage.alarm, null);
}

export async function test_keeper_blocks_on_a_rejected_password_and_never_sends_it_again(): Promise<void> {
  const storage = memoryStorage();
  const wrong = { ...CREDENTIALS, password: "wrong" };
  const fake = fakeOkta({ now: () => NOW });
  const subject = new SessionKeeper({ baseUrl: BASE_URL, storage, okta: wrong, fetch: fake.fetch, now: () => NOW });
  await assert.rejects(subject.credentials(), /blocked \(credentials_rejected\)/u);
  assert.equal(storage.alarm, null);
  const sent = fake.requests.length;
  await assert.rejects(subject.credentials(), /blocked/u);
  assert.equal(fake.requests.length, sent);
  assert.equal((await subject.status()).okta_blocked, "credentials_rejected");
}

export async function test_keeper_status_names_no_secret(): Promise<void> {
  const storage = memoryStorage();
  await keeper(storage, fakeOkta({ now: () => NOW }).fetch, () => NOW).credentials();
  const status = await keeper(storage, fakeOkta({ now: () => NOW }).fetch, () => NOW).status();
  assert.equal(status.username, ONTRACK_USER);
  assert.equal(status.okta, true);
  assert.equal(status.refresh_expires_at, new Date(refreshCookie(storage)!.expires! * 1_000).toISOString());
  const text = JSON.stringify(status);
  for (const secret of ["access-", "refresh-", PASSWORD]) assert.ok(!text.includes(secret), `leaked ${secret}`);
}
