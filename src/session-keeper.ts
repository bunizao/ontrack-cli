import { CliError } from "./errors.js";
import { attemptOktaSignIn, oktaRenewalDue, type OktaAttempt, type OktaState } from "./okta-renewal.js";
import type { OktaCredentials, OnTrackOktaSession, RenewalCookie } from "./okta-sign-in.js";
import { exchangeRefreshCookies, isFuture } from "./token-exchange.js";

// Keeps one OnTrack session alive without a person: the remote MCP Worker's
// Durable Object holds one of these. Runtime-neutral, checked by tsconfig.core.json.
//
// Renewal, cheapest first:
// 1. the access token while it has more than two minutes left;
// 2. Doubtfire's refresh cookie, which mints access tokens until it lapses;
// 3. an Okta sign-in, the only thing that issues a new seven-day refresh cookie.
// An alarm runs (3) 48 hours before the refresh cookie lapses, so requests rarely wait for it.
//
// Doubtfire keeps one refresh token per user, shared with the laptop CLI. Okta
// renewal revokes it first (or Doubtfire hands the lapsing one back), which signs
// the CLI out once; the CLI's own Okta renewal then picks up this token.

export interface KeptSession {
  readonly username: string;
  readonly access_token: string;
  /** ISO 8601. */
  readonly auth_token_expiry: string;
  readonly refresh_cookies: readonly RenewalCookie[];
  readonly user?: Readonly<Record<string, unknown>>;
}

export interface KeeperRecord {
  readonly session?: KeptSession;
  readonly okta?: OktaState;
}

export interface KeeperStorage {
  read(): Promise<KeeperRecord | undefined>;
  write(record: KeeperRecord): Promise<void>;
  /** Null clears the alarm. Milliseconds since the epoch. */
  setAlarm(atMs: number | null): Promise<void>;
}

export interface KeeperOptions {
  readonly baseUrl: string;
  readonly storage: KeeperStorage;
  /** Null when the Worker has no OKTA_* secrets. */
  readonly okta: OktaCredentials | null;
  readonly fetch?: typeof fetch;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
}

export interface KeptCredentials {
  readonly username: string;
  readonly accessToken: string;
  readonly user?: Readonly<Record<string, unknown>> | undefined;
}

export interface KeeperStatus {
  readonly username: string | null;
  readonly access_token_expiry: string | null;
  readonly refresh_expires_at: string | null;
  readonly okta: boolean;
  readonly okta_blocked: string | null;
  readonly okta_next_attempt_at: string | null;
  readonly next_alarm_at: string | null;
}

const ACCESS_TOKEN_MARGIN_MS = 120_000;
const EXCHANGE_TIMEOUT_MS = 30_000;
const RENEW_BEFORE_REFRESH_EXPIRY_MS = 48 * 60 * 60 * 1_000;

export class SessionKeeper {
  private renewing: Promise<KeptCredentials> | undefined;
  private readonly now: () => number;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: KeeperOptions) {
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Usable credentials. `rejected` is an access token OnTrack just refused. */
  async credentials(rejected?: string): Promise<KeptCredentials> {
    const session = (await this.options.storage.read())?.session;
    if (session && this.usable(session, rejected)) return view(session);
    // Concurrent callers share one renewal, so Okta never sees the same code twice.
    this.renewing ??= this.renew(rejected).finally(() => { this.renewing = undefined; });
    return this.renewing;
  }

  /** The Durable Object alarm: Okta renewal ahead of the refresh cookie lapsing. */
  async alarm(): Promise<void> {
    const record = await this.options.storage.read() ?? {};
    if (this.options.okta && oktaRenewalDue(refreshExpiry(record.session), this.now())) {
      // The attempt stores its state and schedules the next alarm whatever the outcome.
      await this.signInThroughOkta(record).catch(() => undefined);
      return;
    }
    await this.schedule(record);
  }

  async status(): Promise<KeeperStatus> {
    const record = await this.options.storage.read() ?? {};
    const refresh = refreshExpiry(record.session);
    const nextAlarm = this.nextAlarm(record);
    return {
      username: record.session?.username ?? null,
      access_token_expiry: record.session?.auth_token_expiry ?? null,
      refresh_expires_at: refresh instanceof Date ? refresh.toISOString() : null,
      okta: this.options.okta !== null,
      okta_blocked: record.okta?.blocked ?? null,
      okta_next_attempt_at: record.okta?.next_attempt_at ? new Date(record.okta.next_attempt_at).toISOString() : null,
      next_alarm_at: nextAlarm === null ? null : new Date(nextAlarm).toISOString(),
    };
  }

  private usable(session: KeptSession, rejected: string | undefined): boolean {
    return session.access_token !== rejected && isFuture(session.auth_token_expiry, new Date(this.now() + ACCESS_TOKEN_MARGIN_MS));
  }

  private async renew(rejected: string | undefined): Promise<KeptCredentials> {
    let record = await this.options.storage.read() ?? {};
    const session = record.session;
    if (session && this.usable(session, rejected)) return view(session);
    const now = new Date(this.now());
    const cookies = session ? liveCookies(session.refresh_cookies, now) : [];
    if (session && cookies.length > 0) {
      const exchanged = await exchangeRefreshCookies(this.options.baseUrl, cookies, this.fetch, now, EXCHANGE_TIMEOUT_MS);
      if (exchanged) {
        if (exchanged.username !== session.username) {
          throw new CliError("auth", `The refresh cookie returned ${exchanged.username}, not ${session.username}.`);
        }
        const renewed: KeptSession = {
          ...session, access_token: exchanged.accessToken, auth_token_expiry: exchanged.authTokenExpiry, user: exchanged.user,
        };
        await this.options.storage.write({ ...record, session: renewed });
        return view(renewed);
      }
      // Refused: the cookie is dead (revoked, or lapsed early). Only Okta can replace it.
      record = { ...record, session: { ...session, refresh_cookies: [] } };
      await this.options.storage.write(record);
    }
    return this.signInThroughOkta(record);
  }

  private async signInThroughOkta(record: KeeperRecord): Promise<KeptCredentials> {
    const credentials = this.options.okta;
    if (!credentials) {
      throw new CliError("auth", "The OnTrack session has lapsed and this Worker has no Okta credentials.",
        undefined, "Run `ontrack mcp deploy --okta` to store them.");
    }
    const attempt = await attemptOktaSignIn({
      baseUrl: this.options.baseUrl,
      credentials,
      state: record.okta,
      expectedUsername: record.session?.username,
      revokeRenewalCookies: record.session?.refresh_cookies,
      fetch: this.fetch,
      now: this.now,
    });
    if (attempt.outcome === "signed_in") {
      const next: KeeperRecord = { session: keptFromOkta(attempt.session), okta: attempt.state };
      await this.options.storage.write(next);
      await this.schedule(next);
      return view(next.session!);
    }
    const next: KeeperRecord = { ...record, okta: attempt.state };
    await this.options.storage.write(next);
    await this.schedule(next);
    throw oktaError(attempt);
  }

  private async schedule(record: KeeperRecord): Promise<void> {
    await this.options.storage.setAlarm(this.nextAlarm(record));
  }

  /** When Okta should next run, or null when nothing will run until something changes. */
  private nextAlarm(record: KeeperRecord): number | null {
    if (!this.options.okta || record.okta?.blocked) return null;
    const refresh = refreshExpiry(record.session);
    const due = refresh === "missing" ? this.now() : refresh === null ? null : refresh.valueOf() - RENEW_BEFORE_REFRESH_EXPIRY_MS;
    if (due === null) return null;
    return Math.max(due, record.okta?.next_attempt_at ?? 0, this.now());
  }
}

function view(session: KeptSession): KeptCredentials {
  return { username: session.username, accessToken: session.access_token, user: session.user };
}

function keptFromOkta(session: OnTrackOktaSession): KeptSession {
  return {
    username: session.username,
    access_token: session.accessToken,
    auth_token_expiry: session.authTokenExpiry,
    refresh_cookies: session.renewalCookies,
    user: session.user,
  };
}

function liveCookies(cookies: readonly RenewalCookie[], now: Date): RenewalCookie[] {
  const live = cookies.filter((cookie) => cookie.expires === undefined || cookie.expires * 1_000 > now.valueOf());
  return live.some((cookie) => cookie.name === "refresh_token") ? live : [];
}

/** "missing" without a refresh cookie, null when it carries no expiry. */
function refreshExpiry(session: KeptSession | undefined): Date | null | "missing" {
  const cookie = session?.refresh_cookies.find((candidate) => candidate.name === "refresh_token");
  if (!cookie) return "missing";
  return cookie.expires === undefined ? null : new Date(cookie.expires * 1_000);
}

function oktaError(attempt: Exclude<OktaAttempt, { outcome: "signed_in" }>): CliError {
  const state = attempt.state;
  if (state.blocked) {
    return new CliError("auth", `Okta sign-in is blocked (${state.blocked}).`, undefined,
      "Fix the credentials in okta-auth, then run `ontrack mcp deploy --okta` again.");
  }
  if (attempt.outcome === "waiting") {
    const at = state.next_attempt_at ? new Date(state.next_attempt_at).toISOString() : "later";
    return new CliError("auth", `Okta sign-in is backing off until ${at}.`);
  }
  const message = attempt.error instanceof Error ? attempt.error.message : String(attempt.error);
  return new CliError("auth", `Okta sign-in failed: ${message}`);
}
