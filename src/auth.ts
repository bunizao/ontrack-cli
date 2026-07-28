import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BrowserCookie, BrowserCookieCandidate } from "./browser-cookies.js";
import type { Environment, OnTrackConfig } from "./config.js";
import { resolveCredentialSource } from "./config.js";
import { CliError } from "./errors.js";
import type { UserView } from "./types.js";
import { safeUserView } from "./user.js";

export type SessionProvenance = "environment" | "config" | "migration" | "session_cache" | "browser";

export interface AuthenticatedSession {
  readonly baseUrl: string;
  readonly username: string;
  readonly accessToken: string;
  readonly authTokenExpiry: string | null;
  readonly provenance: SessionProvenance;
  readonly user: UserView | null;
}

interface StoredSession {
  readonly base_url: string;
  readonly username: string;
  readonly access_token: string;
  readonly auth_token_expiry: string;
  readonly provenance: "browser" | "okta";
}

interface CookieRecord {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
}

interface BrowserSessionOptions {
  readonly baseUrl: string;
  readonly sessionFile: string;
  readonly now?: () => Date;
  readonly exchangeTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly browserCookieProvider?: () => Promise<readonly BrowserCookieCandidate[]>;
}

export interface ResolveAuthenticatedSessionOptions extends BrowserSessionOptions {
  readonly env: Environment;
  readonly config?: OnTrackConfig;
  readonly skipCache?: boolean;
}

export interface LoginAuthenticatedSessionOptions extends BrowserSessionOptions {
  readonly activeLogin?: (url: string) => Promise<readonly BrowserCookieCandidate[]>;
  readonly loginTimeoutMs?: number;
  readonly loginPollIntervalMs?: number;
  readonly onLoginUrl?: (url: string) => void;
  readonly onBrowserWait?: (timeoutMs: number) => void;
  readonly promptEnter?: (message: string) => Promise<void>;
  readonly openBrowser?: (url: string) => Promise<void>;
}

function authError(message: string): CliError {
  return new CliError("auth", message);
}

class RejectedBrowserCookieCandidate extends Error {}

function currentTime(options: BrowserSessionOptions): Date {
  return options.now?.() ?? new Date();
}

function isFuture(value: string, now: Date): boolean {
  const expiry = new Date(value);
  return !Number.isNaN(expiry.valueOf()) && expiry.valueOf() > now.valueOf();
}

function readStoredSession(value: unknown, baseUrl: string, now: Date): StoredSession | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (
    data.base_url !== baseUrl
    || typeof data.username !== "string"
    || !data.username
    || typeof data.access_token !== "string"
    || !data.access_token
    || typeof data.auth_token_expiry !== "string"
    || !isFuture(data.auth_token_expiry, now)
    || (data.provenance !== "browser" && data.provenance !== "okta")
  ) return undefined;
  return {
    base_url: baseUrl,
    username: data.username,
    access_token: data.access_token,
    auth_token_expiry: data.auth_token_expiry,
    provenance: data.provenance,
  };
}

async function loadStoredSession(sessionFile: string, baseUrl: string, now: Date): Promise<AuthenticatedSession | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sessionFile, "utf8"));
    const stored = readStoredSession(parsed, baseUrl, now);
    if (!stored) return undefined;
    return {
      baseUrl: stored.base_url,
      username: stored.username,
      accessToken: stored.access_token,
      authTokenExpiry: stored.auth_token_expiry,
      provenance: "session_cache",
      user: null,
    };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw authError("Could not read the authenticated session cache.");
  }
}

async function saveStoredSession(sessionFile: string, session: AuthenticatedSession): Promise<void> {
  if (!session.authTokenExpiry || session.provenance !== "browser") return;
  const stored: StoredSession = {
    base_url: session.baseUrl,
    username: session.username,
    access_token: session.accessToken,
    auth_token_expiry: session.authTokenExpiry,
    provenance: session.provenance,
  };
  try {
    await mkdir(dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(sessionFile, 0o600);
  } catch {
    throw authError("Could not write the authenticated session cache.");
  }
}

async function discoverLoginUrl(
  baseUrl: string,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  let value: unknown;
  try {
    const response = await fetchImplementation(`${baseUrl}/api/auth/method`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: requestSignal,
    });
    if (!response.ok) throw authError("OnTrack sign-in discovery failed.");
    try {
      value = await response.json();
    } catch {
      if (signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
      if (timeoutController.signal.aborted) throw authError(`Login discovery timed out after ${timeoutMs}ms.`);
      throw new CliError("upstream_contract", "auth method response is invalid");
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
    if (timeoutController.signal.aborted) throw authError(`Login discovery timed out after ${timeoutMs}ms.`);
    throw new CliError("network", "OnTrack sign-in discovery failed.");
  } finally {
    clearTimeout(timeout);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("upstream_contract", "auth method must be an object");
  }
  const method = Reflect.get(value, "method");
  const redirectTo = Reflect.get(value, "redirect_to");
  if (method !== "saml" || typeof redirectTo !== "string" || !redirectTo.trim()) {
    throw new CliError("upstream_contract", "auth method response has no SAML sign-in URL");
  }
  let loginUrl: URL;
  try {
    loginUrl = new URL(redirectTo, baseUrl);
  } catch {
    throw new CliError("upstream_contract", "auth method sign-in URL is invalid");
  }
  if (loginUrl.protocol !== "https:" || loginUrl.username || loginUrl.password) {
    throw new CliError("upstream_contract", "auth method sign-in URL is invalid");
  }
  return loginUrl.href;
}

function domainMatches(hostname: string, cookieDomain: string): boolean {
  const normalized = cookieDomain.toLowerCase().replace(/^\./, "");
  const host = hostname.toLowerCase();
  return Boolean(normalized) && (normalized === host || host.endsWith(`.${normalized}`));
}

function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  if (!requestPath.startsWith(cookiePath)) return false;
  return requestPath.length === cookiePath.length || cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function cookieIsExpired(value: unknown, now: Date): boolean {
  if (value === undefined || value === null || value === "" || value === 0) return false;
  const expiry = typeof value === "number" ? new Date(value * 1_000) : new Date(String(value));
  return Number.isNaN(expiry.valueOf()) || expiry.valueOf() <= now.valueOf();
}

function applicableCookies(records: readonly BrowserCookie[], baseUrl: string, now: Date): CookieRecord[] {
  const url = new URL(baseUrl);
  const hostname = url.hostname;
  const exchangePath = "/api/auth/access-token";
  return records.flatMap((record): CookieRecord[] => {
    const path = typeof record.path === "string" && record.path.startsWith("/") ? record.path : "/";
    if (
      !record.name
      || !record.value
      || typeof record.domain !== "string"
      || !domainMatches(hostname, record.domain)
      || (record.secure === true && url.protocol !== "https:")
      || !cookiePathMatches(exchangePath, path)
      || cookieIsExpired(record.expires, now)
      || /[;\r\n]/.test(record.name)
      || /[;\r\n]/.test(record.value)
    ) return [];
    return [{ name: record.name, value: record.value, domain: record.domain, path }];
  });
}

function cookieHeader(cookies: readonly CookieRecord[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function exchangeCookies(
  baseUrl: string,
  cookies: readonly CookieRecord[],
  fetchImplementation: typeof fetch,
  now: Date,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AuthenticatedSession> {
  if (cookies.length === 0) throw new RejectedBrowserCookieCandidate();
  let response: Response;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: cookieHeader(cookies),
      },
      body: JSON.stringify({ delete_auth_token: false }),
    };
    init.signal = requestSignal;
    response = await fetchImplementation(`${baseUrl}/api/auth/access-token`, init);
  } catch {
    clearTimeout(timeout);
    if (signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
    if (timeoutController.signal.aborted) throw authError(`Cookie exchange timed out after ${timeoutMs}ms.`);
    throw authError("Cookie exchange failed: OnTrack could not be reached.");
  }
  if (!response.ok) {
    clearTimeout(timeout);
    if (response.status === 401 || response.status === 403 || response.status === 419) {
      throw new RejectedBrowserCookieCandidate();
    }
    throw authError(`Cookie exchange failed: OnTrack returned HTTP ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
    if (timeoutController.signal.aborted) throw authError(`Cookie exchange timed out after ${timeoutMs}ms.`);
    throw authError("Cookie exchange failed: OnTrack returned malformed JSON.");
  } finally {
    clearTimeout(timeout);
  }
  if (payload === null) throw new RejectedBrowserCookieCandidate();
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw authError("Cookie exchange failed: OnTrack returned no access token.");
  }
  const data = payload as Record<string, unknown>;
  const user = data.user;
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    throw authError("Cookie exchange failed: OnTrack returned no user.");
  }
  const username = (user as Record<string, unknown>).username;
  if (
    typeof data.auth_token !== "string"
    || !data.auth_token
    || typeof data.auth_token_expiry !== "string"
    || typeof username !== "string"
    || !username
  ) throw authError("Cookie exchange failed: OnTrack returned an incomplete session.");
  if (!isFuture(data.auth_token_expiry, now)) throw authError("The exchanged access token is already expired.");
  const userData = user as Record<string, unknown>;
  return {
    baseUrl,
    username,
    accessToken: data.auth_token,
    authTokenExpiry: new Date(data.auth_token_expiry).toISOString(),
    provenance: "browser",
    user: safeUserView(userData, username),
  };
}

async function exchangeBrowserCookieCandidates(
  options: BrowserSessionOptions,
  now: Date,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
): Promise<AuthenticatedSession | undefined> {
  if (!options.browserCookieProvider) return undefined;
  let candidates: readonly BrowserCookieCandidate[];
  try {
    candidates = await options.browserCookieProvider();
  } catch {
    return undefined;
  }
  for (const candidate of candidates) {
    try {
      const cookies = applicableCookies(candidate.cookies, options.baseUrl, now);
      const session = await exchangeCookies(
        options.baseUrl,
        cookies,
        fetchImplementation,
        now,
        timeoutMs,
        options.signal,
      );
      await saveStoredSession(options.sessionFile, session);
      return session;
    } catch (error) {
      if (error instanceof RejectedBrowserCookieCandidate) continue;
      throw error;
    }
  }
  return undefined;
}

function waitForBrowserCookies(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CliError("cancellation", "Authentication cancelled."));
  return new Promise((resolve, reject) => {
    const cancel = (): void => {
      clearTimeout(timeout);
      reject(new CliError("cancellation", "Authentication cancelled."));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

export async function resolveAuthenticatedSession(
  options: ResolveAuthenticatedSessionOptions,
): Promise<AuthenticatedSession> {
  const config = options.config ?? {};
  const explicit = resolveCredentialSource(options.env, config);
  if (explicit) {
    return {
      baseUrl: options.baseUrl,
      username: explicit.username,
      accessToken: explicit.accessToken,
      authTokenExpiry: null,
      provenance: explicit.provenance,
      user: explicit.user,
    };
  }

  const now = currentTime(options);
  const sessionFile = options.sessionFile;
  if (!options.skipCache) {
    const cached = await loadStoredSession(sessionFile, options.baseUrl, now);
    if (cached) return cached;
  }

  const browserSession = await exchangeBrowserCookieCandidates(
    options,
    now,
    options.fetch ?? fetch,
    options.exchangeTimeoutMs ?? 30_000,
  );
  if (browserSession) return browserSession;
  throw authError("No active OnTrack browser session was found. Run `ontrack auth login` to sign in.");
}

export async function loginAuthenticatedSession(
  options: LoginAuthenticatedSessionOptions,
): Promise<AuthenticatedSession> {
  const now = currentTime(options);
  const fetchImplementation = options.fetch ?? fetch;
  const exchangeTimeoutMs = options.exchangeTimeoutMs ?? 30_000;
  const browserSession = await exchangeBrowserCookieCandidates(
    options,
    now,
    fetchImplementation,
    exchangeTimeoutMs,
  );
  if (browserSession) return browserSession;
  const loginUrl = await discoverLoginUrl(
    options.baseUrl,
    fetchImplementation,
    exchangeTimeoutMs,
    options.signal,
  );
  if (options.activeLogin) {
    const signInPage = new URL("/sign_in", options.baseUrl).href;
    let candidates: readonly BrowserCookieCandidate[];
    try {
      candidates = await options.activeLogin(signInPage);
    } catch {
      if (options.signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
      throw authError("Interactive OnTrack sign-in failed.");
    }
    const session = await exchangeBrowserCookieCandidates(
      { ...options, browserCookieProvider: async () => candidates },
      currentTime(options),
      fetchImplementation,
      exchangeTimeoutMs,
    );
    if (session) return session;
    throw authError("Interactive sign-in completed, but OnTrack did not provide a reusable session.");
  }
  if (!options.promptEnter || !options.openBrowser) {
    throw authError("Interactive browser login is unavailable in this environment.");
  }
  options.onLoginUrl?.(loginUrl);
  try {
    await options.promptEnter("No active OnTrack browser session was found. Press Enter to open the sign-in URL in your default browser.");
  } catch (error) {
    if (options.signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
    if (error instanceof CliError) throw error;
    throw authError("Could not read confirmation for browser sign-in.");
  }
  if (options.signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
  try {
    await options.openBrowser(loginUrl);
  } catch {
    if (options.signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
    throw authError("Could not open the OnTrack sign-in page in your browser.");
  }

  const loginTimeoutMs = options.loginTimeoutMs ?? 300_000;
  options.onBrowserWait?.(loginTimeoutMs);
  const pollIntervalMs = options.loginPollIntervalMs ?? 1_000;
  const deadline = Date.now() + loginTimeoutMs;
  while (true) {
    const pollNow = currentTime(options);
    const session = await exchangeBrowserCookieCandidates(options, pollNow, fetchImplementation, exchangeTimeoutMs);
    if (session) return session;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const signInPage = new URL("/sign_in", options.baseUrl).href;
      throw authError(`No reusable browser session was detected. Open ${signInPage}, enable Remember me, then run \`ontrack auth login\` again.`);
    }
    await waitForBrowserCookies(Math.min(pollIntervalMs, remainingMs), options.signal);
  }
}
