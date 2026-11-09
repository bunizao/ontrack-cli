import { OktaSignInError, signIn, type Cookie, type Fetch, type Progress } from "okta-auth-cli";

// Signs in to OnTrack (Doubtfire) through Okta with plain HTTP, no browser.
// Runtime-neutral: fetch, URL and WebCrypto only, so the CLI and a Worker share it.
// Checked without Node's types by tsconfig.core.json.
//
// Doubtfire's SAML callback redirects to /sign_in?authToken=<one-time>&username=<user>.
// That one-time token is exchanged here with `remember: true`, which is what makes
// Doubtfire issue the refresh cookie (valid seven days, never extended).

export interface OktaCredentials {
  readonly username: string;
  readonly password: string;
  readonly totpSecret: string;
}

export interface OnTrackOktaSignInOptions {
  /** The OnTrack origin, e.g. https://ontrack.example.edu. */
  readonly baseUrl: string;
  readonly credentials: OktaCredentials;
  readonly deviceToken?: string | undefined;
  readonly oktaSession?: readonly Cookie[] | undefined;
  readonly fetch?: Fetch;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
  readonly onProgress?: Progress;
}

/** Doubtfire's `username` and `refresh_token` cookies, as the session cache stores them. */
export interface RenewalCookie {
  readonly name: "username" | "refresh_token";
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  /** Seconds since the epoch. */
  readonly expires?: number;
}

export interface OnTrackOktaSession {
  readonly username: string;
  readonly accessToken: string;
  /** ISO 8601. */
  readonly authTokenExpiry: string;
  readonly user: Record<string, unknown>;
  readonly renewalCookies: readonly RenewalCookie[];
  /** When the refresh cookie lapses; null when Doubtfire sent no expiry. */
  readonly refreshExpiresAt: Date | null;
  /** Pass back next time, so Okta knows this device. */
  readonly deviceToken: string | undefined;
  /** Pass back next time, so Okta skips the password and code while it lasts. */
  readonly oktaSession: Cookie[];
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Throws OktaSignInError. Okta's own codes come from okta-auth; OnTrack's side
 * reports `handoff_failed`, `network` or `http_<status>`. Messages never carry the
 * landing URL, the one-time token or any cookie value.
 */
export async function signInToOnTrack(options: OnTrackOktaSignInOptions): Promise<OnTrackOktaSession> {
  const base = new URL(options.baseUrl);
  const fetchImplementation: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  options.onProgress?.(`Finding the Okta app for ${base.hostname}`);
  const appLink = await oktaAppLink(base, fetchImplementation);

  const signedIn = await signIn({
    url: appLink,
    username: options.credentials.username,
    password: options.credentials.password,
    totpSecret: options.credentials.totpSecret,
    ...(options.deviceToken ? { deviceToken: options.deviceToken } : {}),
    ...(options.oktaSession?.length ? { oktaSession: [...options.oktaSession] } : {}),
    fetch: fetchImplementation,
    now,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  const { username, authToken } = readLanding(signedIn.landingUrl, base);
  options.onProgress?.(`Exchanging the one-time token at ${base.hostname}`);
  const session = await exchangeAuthToken(base, username, authToken, fetchImplementation, now());
  return { ...session, deviceToken: signedIn.deviceToken, oktaSession: signedIn.oktaSession };
}

async function oktaAppLink(base: URL, fetchImplementation: Fetch): Promise<string> {
  const response = await request(fetchImplementation, new URL("/api/auth/method", base), { method: "GET" });
  if (!response.ok) throw new OktaSignInError(`http_${response.status}`, `${base.hostname}/api/auth/method answered ${response.status}`);
  const body = await response.json().catch(() => null) as unknown;
  const redirectTo = isRecord(body) ? body.redirect_to : undefined;
  if (!isRecord(body) || body.method !== "saml" || typeof redirectTo !== "string") {
    throw new OktaSignInError("handoff_failed", `${base.hostname} does not sign in through SAML`);
  }
  const link = new URL(redirectTo, base);
  if (link.protocol !== "https:") throw new OktaSignInError("handoff_failed", `${base.hostname} names a sign-in link that is not https`);
  return link.href;
}

function readLanding(landingUrl: string, base: URL): { username: string; authToken: string } {
  const landing = new URL(landingUrl);
  const authToken = landing.searchParams.get("authToken");
  const username = landing.searchParams.get("username");
  if (landing.origin !== base.origin || landing.pathname !== "/sign_in" || !authToken || !username) {
    // Host and path only: the query string is the one-time token.
    throw new OktaSignInError("handoff_failed", `The SAML post landed on ${landing.hostname}${landing.pathname}, not ${base.hostname}/sign_in with a one-time token`);
  }
  return { username, authToken };
}

async function exchangeAuthToken(
  base: URL,
  username: string,
  authToken: string,
  fetchImplementation: Fetch,
  nowMs: number,
): Promise<Omit<OnTrackOktaSession, "deviceToken" | "oktaSession">> {
  const response = await request(fetchImplementation, new URL("/api/auth", base), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ username, auth_token: authToken, remember: true }),
  });
  if (response.status === 401 || response.status === 403) {
    throw new OktaSignInError("handoff_failed", `${base.hostname} refused the one-time token`);
  }
  if (!response.ok) throw new OktaSignInError(`http_${response.status}`, `${base.hostname}/api/auth answered ${response.status}`);
  const body = await response.json().catch(() => null) as unknown;
  const user = isRecord(body) && isRecord(body.user) ? body.user : undefined;
  if (!isRecord(body) || !user || typeof body.auth_token !== "string" || !body.auth_token
    || typeof body.auth_token_expiry !== "string" || Number.isNaN(Date.parse(body.auth_token_expiry))
    || typeof user.username !== "string" || !user.username) {
    throw new OktaSignInError("handoff_failed", `${base.hostname}/api/auth returned an incomplete session`);
  }
  const renewalCookies = readRenewalCookies(response.headers, base.hostname, nowMs);
  const refresh = renewalCookies.find((cookie) => cookie.name === "refresh_token");
  if (!refresh) throw new OktaSignInError("handoff_failed", `${base.hostname} signed in but issued no refresh cookie`);
  return {
    username: user.username,
    accessToken: body.auth_token,
    authTokenExpiry: new Date(body.auth_token_expiry).toISOString(),
    user,
    renewalCookies,
    refreshExpiresAt: refresh.expires === undefined ? null : new Date(refresh.expires * 1_000),
  };
}

// Only the two cookies the access-token exchange needs, scoped to this host.
function readRenewalCookies(headers: Headers, host: string, nowMs: number): RenewalCookie[] {
  return headers.getSetCookie().flatMap((line): RenewalCookie[] => {
    const [pair = "", ...attributes] = line.split(";");
    const equals = pair.indexOf("=");
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (equals < 1 || !value || (name !== "username" && name !== "refresh_token")) return [];
    let path = "/";
    let secure = false;
    let expires: number | undefined;
    let maxAge: number | undefined;
    for (const attribute of attributes) {
      const [key = "", ...rest] = attribute.split("=");
      const raw = rest.join("=").trim();
      switch (key.trim().toLowerCase()) {
        case "path": if (raw.startsWith("/")) path = raw; break;
        case "secure": secure = true; break;
        case "expires": { const at = Date.parse(raw); if (!Number.isNaN(at)) expires = Math.floor(at / 1_000); break; }
        case "max-age": { const seconds = Number(raw); if (Number.isInteger(seconds)) maxAge = seconds; break; }
      }
    }
    // Max-Age wins over Expires, as in a browser.
    if (maxAge !== undefined) expires = Math.floor(nowMs / 1_000) + maxAge;
    return [{ name, value, domain: host, path, secure, ...(expires === undefined ? {} : { expires }) }];
  });
}

async function request(fetchImplementation: Fetch, url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetchImplementation(url.href, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new OktaSignInError("network", `${url.hostname}${url.pathname} could not be reached`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
