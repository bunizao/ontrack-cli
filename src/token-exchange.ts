import { CliError } from "./errors.js";

// Doubtfire's refresh cookie to access token exchange, shared by the CLI and the
// remote MCP Worker. Runtime-neutral, checked by tsconfig.core.json.

export interface ExchangeCookie {
  readonly name: string;
  readonly value: string;
}

export interface ExchangedSession {
  readonly username: string;
  readonly accessToken: string;
  /** ISO 8601. */
  readonly authTokenExpiry: string;
  readonly user: Readonly<Record<string, unknown>>;
}

export function cookieHeader(cookies: readonly ExchangeCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export function isFuture(value: string, now: Date): boolean {
  const expiry = new Date(value);
  return !Number.isNaN(expiry.valueOf()) && expiry.valueOf() > now.valueOf();
}

/**
 * POST /api/auth/access-token with the cookies. Resolves null when OnTrack refuses
 * them (401, 403, 419 or a null body), which is the only answer that means the
 * cookie is dead. Network failures and other statuses throw.
 */
export async function exchangeRefreshCookies(
  baseUrl: string,
  cookies: readonly ExchangeCookie[],
  fetchImplementation: typeof fetch,
  now: Date,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExchangedSession | null> {
  if (cookies.length === 0) return null;
  let response: Response;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    response = await fetchImplementation(`${baseUrl}/api/auth/access-token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: cookieHeader(cookies),
      },
      body: JSON.stringify({ delete_auth_token: false }),
      // A 3xx comes back as a failed response; Workers does not implement "error".
      redirect: "manual",
      signal: requestSignal,
    });
  } catch {
    clearTimeout(timeout);
    if (signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
    if (timeoutController.signal.aborted) throw new CliError("network", `Cookie exchange timed out after ${timeoutMs}ms.`);
    throw new CliError("network", "Cookie exchange failed: OnTrack could not be reached.");
  }
  if (!response.ok) {
    clearTimeout(timeout);
    if (response.status === 401 || response.status === 403 || response.status === 419) return null;
    throw new CliError("upstream_api", `Cookie exchange failed: OnTrack returned HTTP ${response.status}.`, response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
    if (timeoutController.signal.aborted) throw new CliError("network", `Cookie exchange timed out after ${timeoutMs}ms.`);
    throw new CliError("upstream_contract", "Cookie exchange failed: OnTrack returned malformed JSON.");
  } finally {
    clearTimeout(timeout);
  }
  if (payload === null) return null;
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new CliError("auth", "Cookie exchange failed: OnTrack returned no access token.");
  }
  const data = payload as Record<string, unknown>;
  const user = data.user;
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    throw new CliError("auth", "Cookie exchange failed: OnTrack returned no user.");
  }
  const username = (user as Record<string, unknown>).username;
  if (
    typeof data.auth_token !== "string"
    || !data.auth_token
    || typeof data.auth_token_expiry !== "string"
    || typeof username !== "string"
    || !username
  ) throw new CliError("auth", "Cookie exchange failed: OnTrack returned an incomplete session.");
  if (!isFuture(data.auth_token_expiry, now)) throw new CliError("auth", "The exchanged access token is already expired.");
  return {
    username,
    accessToken: data.auth_token,
    authTokenExpiry: new Date(data.auth_token_expiry).toISOString(),
    user: user as Record<string, unknown>,
  };
}
