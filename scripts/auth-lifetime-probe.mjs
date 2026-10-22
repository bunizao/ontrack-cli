#!/usr/bin/env node
// Measures how long OnTrack's browser credentials last, without printing them.
//
//   npm run build
//   node scripts/auth-lifetime-probe.mjs              one snapshot
//   node scripts/auth-lifetime-probe.mjs --watch 60   one JSON line every 60 minutes
//
// The snapshot reads the browser's `username` + `refresh_token` cookies the same way
// `ontrack auth login` does, reports the refresh token's Expires, and exchanges it once
// for an access token to report that token's expiry. Watch mode keeps the first refresh
// token it captured in memory only, exchanges it on every tick, and also re-reads the
// browser, so the log shows how long a held refresh token keeps minting access tokens
// on its own and whether the browser was issued a new one meanwhile. It stops when the
// held token is refused. Token values never leave the process: they are shown as the
// first 8 hex digits of their SHA-256, enough to tell whether a token changed.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const EXCHANGE_PATH = "/api/auth/access-token";

export function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function instant(value) {
  if (value === undefined || value === null || value === "" || value === 0) return null;
  const date = typeof value === "number" ? new Date(value * 1_000) : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date;
}

function hoursUntil(date, now) {
  return date ? Math.round(((date.valueOf() - now.valueOf()) / 3_600_000) * 100) / 100 : null;
}

function describeRefreshCookie(cookies, now) {
  const refresh = cookies.find((cookie) => cookie.name === "refresh_token");
  if (!refresh) return null;
  const expires = instant(refresh.expires);
  return {
    fp: fingerprint(refresh.value),
    expires_at: expires?.toISOString() ?? null,
    hours_left: hoursUntil(expires, now),
    persistent: expires !== null,
  };
}

// Names and expiry of any cookies the exchange response sets; never their values.
function setCookieSummary(headers) {
  const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  return lines.map((line) => {
    const [pair, ...attributes] = line.split(";");
    const name = pair.split("=")[0].trim();
    const expires = attributes.map((part) => part.trim()).find((part) => /^expires=/iu.test(part));
    return { name, cleared: /=\s*$/u.test(pair) || /1970/u.test(expires ?? ""), expires: expires?.slice(8) ?? null };
  });
}

export async function exchange(baseUrl, cookies, now, fetchImplementation = fetch) {
  const header = cookies
    .filter((cookie) => cookie.name === "username" || cookie.name === "refresh_token")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  let response;
  try {
    response = await fetchImplementation(new URL(EXCHANGE_PATH, baseUrl).href, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Cookie: header },
      // false keeps the browser's current access token alive; the default would delete it.
      body: JSON.stringify({ delete_auth_token: false }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.name : "fetch failed" };
  }
  const set_cookies = setCookieSummary(response.headers);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const token = payload && typeof payload.auth_token === "string" ? payload.auth_token : null;
  if (!response.ok || !token) {
    // Doubtfire answers a dead refresh token with 200 and `null`, and clears the cookies.
    return { ok: false, status: response.status, set_cookies };
  }
  const expires = instant(payload.auth_token_expiry);
  return {
    ok: true,
    status: response.status,
    access_token: { fp: fingerprint(token), expires_at: expires?.toISOString() ?? null, hours_left: hoursUntil(expires, now) },
    set_cookies,
  };
}

export async function snapshot(baseUrl, candidates, now, fetchImplementation = fetch) {
  const results = [];
  for (const candidate of candidates) {
    results.push({
      source: candidate.source,
      refresh_token: describeRefreshCookie(candidate.cookies, now),
      exchange: await exchange(baseUrl, candidate.cookies, now, fetchImplementation),
    });
  }
  return { site: baseUrl, checked_at: now.toISOString(), candidates: results };
}

export async function watchTick(baseUrl, held, browserCandidates, now, fetchImplementation = fetch) {
  const heldExchange = await exchange(baseUrl, held.cookies, now, fetchImplementation);
  const browser = browserCandidates.map((candidate) => ({
    source: candidate.source,
    refresh_token: describeRefreshCookie(candidate.cookies, now),
  }));
  return {
    at: now.toISOString(),
    hours_since_capture: hoursUntil(now, held.capturedAt),
    held: { source: held.source, refresh_token: describeRefreshCookie(held.cookies, now), exchange: heldExchange },
    browser,
    held_rt_dead: !heldExchange.ok && heldExchange.status !== null,
  };
}

async function loadCli() {
  const dist = new URL("../dist/", import.meta.url);
  if (!existsSync(new URL("config.js", dist))) {
    throw new Error("Run `npm run build` first; the probe reuses the built CLI's cookie reader.");
  }
  const config = await import(new URL("config.js", dist).href);
  const cookies = await import(new URL("browser-cookies.js", dist).href);
  const paths = config.resolveConfigPaths({
    env: process.env,
    platform: process.platform,
    homeDir: homedir(),
    cwd: process.cwd(),
  });
  const baseUrl = config.resolveBaseUrl(process.env, config.loadConfig(paths));
  const read = () => cookies.authenticationCookieCandidates(baseUrl, {
    onWarning: (warning) => process.stderr.write(`warning: ${warning}\n`),
  });
  return { baseUrl, read };
}

function parseWatchMinutes(argv) {
  const index = argv.indexOf("--watch");
  if (index < 0) return null;
  const minutes = Number(argv[index + 1] ?? 60);
  if (!Number.isFinite(minutes) || minutes < 1) throw new Error("--watch takes a whole number of minutes, at least 1.");
  return minutes;
}

async function main(argv) {
  const minutes = parseWatchMinutes(argv);
  const { baseUrl, read } = await loadCli();
  const candidates = await read();
  if (candidates.length === 0) {
    throw new Error("No browser holds OnTrack's username + refresh_token cookies. Sign in to OnTrack in the browser first.");
  }
  if (minutes === null) {
    process.stdout.write(`${JSON.stringify(await snapshot(baseUrl, candidates, new Date()), null, 2)}\n`);
    return;
  }

  const held = { ...candidates[0], capturedAt: new Date() };
  process.stderr.write(`Holding the refresh token from ${held.source}; one line every ${minutes} min. Ctrl-C to stop.\n`);
  for (;;) {
    let browser = [];
    try {
      browser = await read();
    } catch (error) {
      process.stderr.write(`warning: could not re-read browser cookies: ${error instanceof Error ? error.message : error}\n`);
    }
    const line = await watchTick(baseUrl, held, browser, new Date());
    process.stdout.write(`${JSON.stringify(line)}\n`);
    if (line.held_rt_dead) {
      process.stderr.write(`The held refresh token was refused after ${line.hours_since_capture} h.\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
