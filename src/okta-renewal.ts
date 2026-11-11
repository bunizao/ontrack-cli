import { OktaSignInError, type Cookie, type Fetch, type Progress } from "okta-auth-cli";

import { signInToOnTrack, type OktaCredentials, type OnTrackOktaSession } from "./okta-sign-in.js";

// When an unattended caller (the CLI renewing in the background, or a Worker) may
// sign in through Okta again, and what it remembers between attempts.
// Runtime-neutral, like okta-sign-in.ts. The caller stores OktaState wherever its
// session lives, encrypted: it holds Okta's device token and session cookies.

export interface OktaState {
  /** SHA-256 of the credentials the fields below belong to. New credentials start over. */
  readonly secrets: string;
  /** A refusal no retry can fix, or too many transient failures. Nothing runs while set. */
  readonly blocked?: OktaBlockCode;
  readonly failures: number;
  /** Milliseconds since the epoch. */
  readonly next_attempt_at?: number;
  readonly device_token?: string;
  readonly okta_session?: Cookie[];
}

export type OktaBlockCode =
  | "credentials_rejected"
  | "passcode_rejected"
  | "mfa_unsupported"
  | "invalid_secret"
  | "account_mismatch"
  | "retries_exhausted";

export type OktaAttempt =
  | { readonly outcome: "signed_in"; readonly state: OktaState; readonly session: OnTrackOktaSession }
  | { readonly outcome: "failed"; readonly state: OktaState; readonly error: unknown }
  /** Blocked or backing off: nothing was sent. */
  | { readonly outcome: "waiting"; readonly state: OktaState };

export interface OktaAttemptOptions {
  readonly baseUrl: string;
  readonly credentials: OktaCredentials;
  readonly state: OktaState | undefined;
  /** The OnTrack account already held. A different one is refused and blocks. */
  readonly expectedUsername?: string | undefined;
  /** A person asked for this sign-in: lifts a block and the backoff. */
  readonly explicit?: boolean;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly onProgress?: Progress;
  /** Aborting rejects with the signal's reason and records nothing in the state. */
  readonly signal?: AbortSignal;
}

/** Re-sign in this long before the seven-day refresh cookie lapses. */
export const RENEW_BEFORE_REFRESH_EXPIRY_MS = 48 * 60 * 60 * 1_000;
// Okta accepts a TOTP code once: two attempts inside one 30-second window would
// send the same code and read as a rejected passcode.
export const MIN_ATTEMPT_INTERVAL_MS = 60 * 1_000;
export const MAX_TRANSIENT_FAILURES = 5;
const MAX_BACKOFF_MS = 30 * 60 * 1_000;

/** All three, or null: an unattended sign-in needs every one. */
export function oktaCredentialsFrom(env: Readonly<Record<string, string | undefined>>): OktaCredentials | null {
  const username = env.OKTA_USERNAME?.trim();
  const password = env.OKTA_PASSWORD;
  const totpSecret = env.OKTA_TOTP_SECRET?.trim();
  return username && password && totpSecret ? { username, password, totpSecret } : null;
}

/** True when the refresh cookie is gone or has under 48 hours left. */
export function oktaRenewalDue(refreshExpiresAt: Date | null | "missing", nowMs: number): boolean {
  if (refreshExpiresAt === "missing") return true;
  return refreshExpiresAt !== null && refreshExpiresAt.valueOf() - nowMs < RENEW_BEFORE_REFRESH_EXPIRY_MS;
}

/**
 * One sign-in attempt under the rules: never repeat a refusal that a retry cannot
 * fix (until the credentials change or a person asks), back off on anything else,
 * and stop after MAX_TRANSIENT_FAILURES in a row. The caller persists `state`
 * whatever the outcome.
 */
export async function attemptOktaSignIn(options: OktaAttemptOptions): Promise<OktaAttempt> {
  const now = options.now ?? Date.now;
  let state = stateFor(options.state, await credentialsDigest(options.credentials));
  if (options.explicit) state = lifted(state);
  if (state.blocked || (state.next_attempt_at !== undefined && state.next_attempt_at > now())) return { outcome: "waiting", state };
  try {
    const session = await signInToOnTrack({
      baseUrl: options.baseUrl,
      credentials: options.credentials,
      deviceToken: state.device_token,
      oktaSession: state.okta_session,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      now,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const remembered = remember(state, session);
    if (options.expectedUsername && session.username !== options.expectedUsername) {
      return { outcome: "failed", state: { ...remembered, blocked: "account_mismatch" }, error: new OktaAccountMismatch() };
    }
    return { outcome: "signed_in", state: { ...remembered, failures: 0, next_attempt_at: now() + MIN_ATTEMPT_INTERVAL_MS }, session };
  } catch (error) {
    // A cancelled attempt says nothing about the credentials.
    options.signal?.throwIfAborted();
    return { outcome: "failed", state: afterFailure(state, error, now()), error };
  }
}

export class OktaAccountMismatch extends Error {
  override readonly name = "OktaAccountMismatch";
  constructor() {
    super("Okta signed in to a different OnTrack account than the one already held.");
  }
}

// Only ever kept inside the encrypted session, so a plain SHA-256 is enough to
// tell whether the credentials changed.
async function credentialsDigest(credentials: OktaCredentials): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([credentials.username, credentials.password, credentials.totpSecret]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stateFor(stored: OktaState | undefined, digest: string): OktaState {
  if (stored?.secrets === digest) return stored;
  // Another account must not ride on the old one's Okta session. The device
  // token names this machine, not the account, so it stays.
  return { secrets: digest, failures: 0, ...(stored?.device_token ? { device_token: stored.device_token } : {}) };
}

function lifted(state: OktaState): OktaState {
  const { blocked: _blocked, next_attempt_at: _next, ...rest } = state;
  return { ...rest, failures: 0 };
}

function remember(state: OktaState, session: OnTrackOktaSession): OktaState {
  const { blocked: _blocked, ...rest } = state;
  const deviceToken = session.deviceToken ?? state.device_token;
  return { ...rest, ...(deviceToken ? { device_token: deviceToken } : {}), okta_session: session.oktaSession };
}

function afterFailure(state: OktaState, error: unknown, nowMs: number): OktaState {
  const { next_attempt_at: _next, ...kept } = state;
  // A failed sign-in that reached Okta still names this device. The property is
  // non-enumerable, so it is read directly.
  const deviceToken = error instanceof OktaSignInError ? error.deviceToken : undefined;
  const rest = deviceToken ? { ...kept, device_token: deviceToken } : kept;
  const permanent = permanentCode(error);
  if (permanent) return { ...rest, blocked: permanent };
  const failures = state.failures + 1;
  if (failures >= MAX_TRANSIENT_FAILURES) return { ...rest, failures, blocked: "retries_exhausted" };
  const delay = Math.min(MIN_ATTEMPT_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
  return { ...rest, failures, next_attempt_at: nowMs + delay };
}

function permanentCode(error: unknown): OktaBlockCode | null {
  if (error instanceof OktaSignInError) {
    return error.code === "credentials_rejected" || error.code === "passcode_rejected" || error.code === "mfa_unsupported"
      ? error.code : null;
  }
  // okta-auth throws TypeError for input it refuses before reaching Okta, such
  // as a TOTP secret that is not base32.
  return error instanceof TypeError ? "invalid_secret" : null;
}

/** Reads a stored OktaState back, or undefined when it is not one. */
export function readOktaState(value: unknown): OktaState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (typeof data.secrets !== "string" || typeof data.failures !== "number") return undefined;
  const blocked = typeof data.blocked === "string" && BLOCK_CODES.has(data.blocked) ? data.blocked as OktaBlockCode : undefined;
  const session = Array.isArray(data.okta_session) ? data.okta_session.filter(isCookie) : undefined;
  return {
    secrets: data.secrets,
    failures: data.failures,
    ...(blocked ? { blocked } : {}),
    ...(typeof data.next_attempt_at === "number" ? { next_attempt_at: data.next_attempt_at } : {}),
    ...(typeof data.device_token === "string" && data.device_token ? { device_token: data.device_token } : {}),
    ...(session?.length ? { okta_session: session } : {}),
  };
}

const BLOCK_CODES = new Set<string>(["credentials_rejected", "passcode_rejected", "mfa_unsupported", "invalid_secret", "account_mismatch", "retries_exhausted"]);

function isCookie(value: unknown): value is Cookie {
  if (typeof value !== "object" || value === null) return false;
  const cookie = value as Record<string, unknown>;
  return typeof cookie.name === "string" && typeof cookie.value === "string" && typeof cookie.domain === "string"
    && typeof cookie.path === "string" && typeof cookie.secure === "boolean" && typeof cookie.httpOnly === "boolean"
    && (cookie.expires === undefined || typeof cookie.expires === "number");
}
