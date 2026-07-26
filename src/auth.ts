import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Environment, OnTrackConfig } from "./config.js";
import { resolveCredentialSource } from "./config.js";
import { CliError } from "./errors.js";
import type { UserView } from "./types.js";
import { safeUserView } from "./user.js";

export type SessionProvenance = "environment" | "config" | "migration" | "session_cache" | "okta";

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
  readonly provenance: "okta";
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
  readonly config?: OnTrackConfig;
  readonly now?: Date;
  readonly oktaExecutable?: string;
  readonly oktaTimeoutMs?: number;
  readonly exchangeTimeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly skipCache?: boolean;
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
    || data.provenance !== "okta"
  ) return undefined;
  return {
    base_url: baseUrl,
    username: data.username,
    access_token: data.access_token,
    auth_token_expiry: data.auth_token_expiry,
    provenance: "okta",
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
  if (!session.authTokenExpiry || session.provenance !== "okta") return;
  const stored: StoredSession = {
    base_url: session.baseUrl,
    username: session.username,
    access_token: session.accessToken,
    auth_token_expiry: session.authTokenExpiry,
    provenance: "okta",
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

function runOkta(executable: string, baseUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
  if (signal?.aborted) return Promise.reject(new CliError("cancellation", "Authentication cancelled."));
  const useCommandShell = process.platform === "win32" && !executable.toLowerCase().endsWith(".exe");
  if (useCommandShell && /["\r\n&|<>^%]/u.test(executable)) {
    return Promise.reject(authError("Okta provider path is unsafe."));
  }
  const command = useCommandShell ? process.env.ComSpec ?? "cmd.exe" : executable;
  const commandExecutable = /[\\/]/u.test(executable) ? `"${executable}"` : executable;
  const args = useCommandShell
    ? ["/d", "/v:off", "/s", "/c", `call ${commandExecutable} cookies --json "%ONTRACK_OKTA_BASE_URL%"`]
    : ["cookies", "--json", baseUrl];
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        signal,
        env: useCommandShell ? { ...process.env, ONTRACK_OKTA_BASE_URL: baseUrl } : process.env,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (signal?.aborted) {
          reject(new CliError("cancellation", "Authentication cancelled."));
          return;
        }
        if (code === "ENOENT" || (useCommandShell && /not recognized|cannot find/iu.test(stderr))) {
          reject(authError("Okta provider is unavailable."));
          return;
        }
        if (error.killed || error.signal) {
          reject(authError("Okta provider timed out."));
          return;
        }
        if (/no stored (?:Okta )?session|not logged in|no session/iu.test(stderr)) {
          reject(authError("No stored Okta session is available."));
          return;
        }
        reject(authError("Okta provider failed."));
      },
    );
  });
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
    provenance: "okta",
    user: safeUserView(userData, username),
  };
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

  const processResult = await runOkta(
    options.oktaExecutable ?? "okta",
    options.baseUrl,
    options.oktaTimeoutMs ?? 30_000,
    options.signal,
  );
  const cookies = readCookies(processResult.stdout, options.baseUrl, now);
  const session = await exchangeCookies(
    options.baseUrl,
    cookies,
    options.fetch ?? fetch,
    now,
    options.exchangeTimeoutMs ?? 30_000,
    options.signal,
  );
  await saveStoredSession(sessionFile, session);
  return session;
}
