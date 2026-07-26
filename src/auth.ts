import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BrowserCookieCandidate } from "./browser-cookies.js";
import type { Environment, OnTrackConfig } from "./config.js";
import { resolveCredentialSource } from "./config.js";
import { CliError } from "./errors.js";
import type { UserView } from "./types.js";
import { safeUserView } from "./user.js";

export type SessionProvenance = "environment" | "config" | "migration" | "session_cache" | "browser" | "okta";

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

export interface ResolveAuthenticatedSessionOptions {
  readonly baseUrl: string;
  readonly sessionFile: string;
  readonly env: Environment;
  readonly platform: NodeJS.Platform;
  readonly config?: OnTrackConfig;
  readonly now?: Date;
  readonly oktaExecutable?: string;
  readonly oktaTimeoutMs?: number;
  readonly exchangeTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly skipCache?: boolean;
  readonly browserCookieProvider?: () => Promise<readonly BrowserCookieCandidate[]>;
}

export interface LoginAuthenticatedSessionOptions extends Omit<ResolveAuthenticatedSessionOptions, "skipCache"> {
  readonly promptOutput?: (text: string) => void;
}

function authError(message: string): CliError {
  return new CliError("auth", message);
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
  if (!session.authTokenExpiry || (session.provenance !== "browser" && session.provenance !== "okta")) return;
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

interface ProcessResult {
  readonly stdout: string;
}

interface OktaProcessOptions {
  readonly executable: string;
  readonly command: "login" | "cookies";
  readonly targetUrl: string;
  readonly timeoutMs: number;
  readonly platform: NodeJS.Platform;
  readonly env: Environment;
  readonly signal?: AbortSignal;
  readonly promptOutput?: (text: string) => void;
}

const LOGIN_SETTLE_MS = 5_000;

function visibleLoginPrompts(stdout: string): string {
  return [...stdout.matchAll(/(?:Username|TOTP secret \(optional\)): /gu)]
    .map((match) => match[0])
    .join("");
}

function runOkta(options: OktaProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.reject(new CliError("cancellation", "Authentication cancelled."));
  const useCommandShell = options.platform === "win32" && !options.executable.toLowerCase().endsWith(".exe");
  if (useCommandShell && /["\r\n&|<>^%]/u.test(options.executable)) {
    return Promise.reject(authError("Okta provider path is unsafe."));
  }
  const command = useCommandShell ? options.env.ComSpec ?? "cmd.exe" : options.executable;
  const commandArguments = options.command === "login"
    ? `login --headed --timeout-ms ${options.timeoutMs} --settle-ms ${LOGIN_SETTLE_MS} --json`
    : "cookies --json";
  const commandLine = `"${options.executable}" ${commandArguments} "%ONTRACK_OKTA_TARGET_URL%"`;
  const args = useCommandShell
    ? ["/d", "/v:off", "/s", "/c", `"${commandLine}"`]
    : options.command === "login"
      ? ["login", "--headed", "--timeout-ms", String(options.timeoutMs), "--settle-ms", String(LOGIN_SETTLE_MS), "--json", options.targetUrl]
      : ["cookies", "--json", options.targetUrl];
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let promptLength = 0;
    const child = spawn(
      command,
      args,
      {
        windowsHide: true,
        signal: options.signal,
        env: useCommandShell ? { ...options.env, ONTRACK_OKTA_TARGET_URL: options.targetUrl } : options.env,
        windowsVerbatimArguments: useCommandShell,
        stdio: [options.command === "login" ? "inherit" : "ignore", "pipe", "pipe"],
      },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const append = (current: string, chunk: string): string => {
      if (current.length + chunk.length > 1024 * 1024) {
        child.kill();
        return current;
      }
      return current + chunk;
    };
    child.stdout.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
      if (options.command !== "login" || !options.promptOutput) return;
      const payloadStart = stdout.indexOf("{");
      const prompts = visibleLoginPrompts(payloadStart < 0 ? stdout : stdout.slice(0, payloadStart));
      if (prompts.length > promptLength) options.promptOutput(prompts.slice(promptLength));
      promptLength = prompts.length;
    });
    child.stderr.on("data", (chunk: string) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (options.signal?.aborted) reject(new CliError("cancellation", "Authentication cancelled."));
      else if (error.code === "ENOENT") reject(authError("Okta provider is unavailable."));
      else reject(authError(options.command === "login" ? "Okta login failed." : "Okta provider failed."));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (options.signal?.aborted) reject(new CliError("cancellation", "Authentication cancelled."));
      else if (timedOut) reject(authError(options.command === "login" ? "Okta login timed out." : "Okta provider timed out."));
      else if (code === 0) resolve({ stdout });
      else if (useCommandShell && /not recognized|cannot find/iu.test(stderr)) reject(authError("Okta provider is unavailable."));
      else if (options.command === "login") reject(authError("Okta login failed."));
      else if (/no stored (?:Okta )?session|not logged in|no session/iu.test(stderr)) reject(authError("No stored Okta session is available."));
      else reject(authError("Okta provider failed."));
    });
  });
}

function validateLoginResult(stdout: string): void {
  for (let index = stdout.lastIndexOf("{"); index >= 0; index = stdout.lastIndexOf("{", index - 1)) {
    try {
      const value: unknown = JSON.parse(stdout.slice(index));
      if (typeof value === "object" && value !== null && !Array.isArray(value) && Reflect.get(value, "success") === true) return;
    } catch {
      // Keep searching for the start of the final provider payload.
    }
  }
  throw authError("Okta login failed.");
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
  return normalized === host || host.endsWith(`.${normalized}`);
}

function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  if (!requestPath.startsWith(cookiePath)) return false;
  return requestPath.length === cookiePath.length || cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function cookieIsExpired(value: unknown, now: Date): boolean {
  if (value === undefined || value === null || value === "") return false;
  const expiry = typeof value === "number" ? new Date(value * 1_000) : new Date(String(value));
  return Number.isNaN(expiry.valueOf()) || expiry.valueOf() <= now.valueOf();
}

function readCookies(stdout: string, baseUrl: string, now: Date): CookieRecord[] {
  if (!stdout.trim()) throw authError("Okta provider returned empty output.");
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw authError("Okta provider returned malformed JSON.");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw authError("Okta provider returned malformed JSON.");
  }
  const records = (payload as Record<string, unknown>).cookies;
  if (!Array.isArray(records)) throw authError("Okta provider returned malformed JSON.");
  const url = new URL(baseUrl);
  const hostname = url.hostname;
  const exchangePath = "/api/auth/access-token";
  return records.flatMap((record): CookieRecord[] => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) return [];
    const data = record as Record<string, unknown>;
    const path = typeof data.path === "string" && data.path.startsWith("/") ? data.path : "/";
    if (
      typeof data.name !== "string"
      || !data.name
      || typeof data.value !== "string"
      || !data.value
      || typeof data.domain !== "string"
      || !domainMatches(hostname, data.domain)
      || (data.secure === true && url.protocol !== "https:")
      || !cookiePathMatches(exchangePath, path)
      || cookieIsExpired(data.expires ?? data.expirationDate, now)
      || /[;\r\n]/.test(data.name)
      || /[;\r\n]/.test(data.value)
    ) return [];
    return [{ name: data.name, value: data.value, domain: data.domain, path }];
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
  provenance: "browser" | "okta" = "okta",
): Promise<AuthenticatedSession> {
  if (cookies.length === 0) throw authError("Cookie exchange failed: the Okta session has no OnTrack cookies.");
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
    throw authError("Cookie exchange failed: OnTrack rejected the stored session.");
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
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
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
    provenance,
    user: safeUserView(userData, username),
  };
}

async function exchangeBrowserCookieCandidates(
  options: ResolveAuthenticatedSessionOptions,
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
      const cookies = readCookies(JSON.stringify({ cookies: candidate.cookies }), options.baseUrl, now);
      const session = await exchangeCookies(
        options.baseUrl,
        cookies,
        fetchImplementation,
        now,
        timeoutMs,
        options.signal,
        "browser",
      );
      await saveStoredSession(options.sessionFile, session);
      return session;
    } catch (error) {
      if (error instanceof CliError && error.category === "cancellation") throw error;
    }
  }
  return undefined;
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

  const now = options.now ?? new Date();
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

  const processOptions = {
    executable: options.oktaExecutable ?? "okta",
    command: "cookies" as const,
    timeoutMs: options.oktaTimeoutMs ?? 30_000,
    platform: options.platform,
    env: options.env,
    ...(options.signal ? { signal: options.signal } : {}),
  };
  let firstError: unknown;
  try {
    const processResult = await runOkta({ ...processOptions, targetUrl: options.baseUrl });
    const session = await exchangeCookies(
      options.baseUrl,
      readCookies(processResult.stdout, options.baseUrl, now),
      options.fetch ?? fetch,
      now,
      options.exchangeTimeoutMs ?? 30_000,
      options.signal,
    );
    await saveStoredSession(sessionFile, session);
    return session;
  } catch (error) {
    if (error instanceof CliError && error.category === "cancellation") throw error;
    firstError = error;
  }
  let loginUrl: string;
  try {
    loginUrl = await discoverLoginUrl(
      options.baseUrl,
      options.fetch ?? fetch,
      options.exchangeTimeoutMs ?? 30_000,
      options.signal,
    );
  } catch (discoveryError) {
    if (discoveryError instanceof CliError && discoveryError.category === "cancellation") throw discoveryError;
    throw firstError;
  }
  const processResult = await runOkta({ ...processOptions, targetUrl: loginUrl });
  const session = await exchangeCookies(
    options.baseUrl,
    readCookies(processResult.stdout, options.baseUrl, now),
    options.fetch ?? fetch,
    now,
    options.exchangeTimeoutMs ?? 30_000,
    options.signal,
  );
  await saveStoredSession(sessionFile, session);
  return session;
}

export async function loginAuthenticatedSession(
  options: LoginAuthenticatedSessionOptions,
): Promise<AuthenticatedSession> {
  const now = options.now ?? new Date();
  const fetchImplementation = options.fetch ?? fetch;
  const exchangeTimeoutMs = options.exchangeTimeoutMs ?? 30_000;
  const browserSession = await exchangeBrowserCookieCandidates(
    options,
    now,
    fetchImplementation,
    exchangeTimeoutMs,
  );
  if (browserSession) return browserSession;
  const commonProcess = {
    executable: options.oktaExecutable ?? "okta",
    timeoutMs: options.oktaTimeoutMs ?? 120_000,
    platform: options.platform,
    env: options.env,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.promptOutput ? { promptOutput: options.promptOutput } : {}),
  };
  try {
    const result = await runOkta({
      ...commonProcess,
      command: "cookies",
      targetUrl: options.baseUrl,
    });
    const session = await exchangeCookies(
      options.baseUrl,
      readCookies(result.stdout, options.baseUrl, now),
      fetchImplementation,
      now,
      exchangeTimeoutMs,
      options.signal,
    );
    await saveStoredSession(options.sessionFile, session);
    return session;
  } catch (error) {
    if (error instanceof CliError && error.category === "cancellation") throw error;
  }
  const loginUrl = await discoverLoginUrl(
    options.baseUrl,
    fetchImplementation,
    exchangeTimeoutMs,
    options.signal,
  );
  const common = {
    ...commonProcess,
    targetUrl: loginUrl,
  };
  validateLoginResult((await runOkta({ ...common, command: "login" })).stdout);
  const cookies = readCookies((await runOkta({ ...common, command: "cookies" })).stdout, options.baseUrl, now);
  const session = await exchangeCookies(
    options.baseUrl,
    cookies,
    fetchImplementation,
    now,
    exchangeTimeoutMs,
    options.signal,
  );
  await saveStoredSession(options.sessionFile, session);
  return session;
}
