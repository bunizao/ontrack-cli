import { totp } from "okta-auth-cli";

// A scripted Okta Identity Engine org (example.okta.com) in front of an OnTrack
// (Doubtfire) site (ontrack.example.edu), served through a fake fetch. Enough of
// IDX for okta-auth's signIn: password on the identify form, a TOTP code, then
// the SAML post to Doubtfire, which redirects to /sign_in?authToken=…&username=….
// Never a real Okta org.

export const ONTRACK = "ontrack.example.edu";
export const BASE_URL = `https://${ONTRACK}`;
export const OKTA = "example.okta.com";
export const USERNAME = "student@example.edu";
export const PASSWORD = "correct horse battery staple";
export const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
export const ONTRACK_USER = "stud0001";
export const AUTH_TOKEN = "one-time-auth-token";
export const CREDENTIALS = { username: USERNAME, password: PASSWORD, totpSecret: TOTP_SECRET };

const IDX = "application/ion+json; okta-version=1.0.0";
const STATE_TOKEN = "02.state";
const APP_PATH = "/app/monash_ontrack/exk3/sso/saml";
const SAML_RESPONSE = "PHNhbWw+";
const REFRESH_LIFETIME_S = 7 * 24 * 60 * 60;

export interface FakeOktaOptions {
  now: () => number;
  // The second factor Okta asks for. phone_number is one okta-auth can't answer.
  factor?: "google_otp" | "phone_number";
  // Every request fails as if the network were down.
  offline?: boolean;
  // The OnTrack account Doubtfire signs the Okta user in to.
  ontrackUser?: string;
  // Doubtfire's SAML callback lands somewhere without a one-time token.
  noAuthToken?: boolean;
  // Doubtfire refuses every refresh cookie, as after a server-side sign-out.
  refuseRefresh?: boolean;
}

export interface RecordedRequest {
  method: string;
  url: URL;
  cookies: Map<string, string>;
  body: string;
}

export function fakeOkta(options: FakeOktaOptions) {
  const requests: RecordedRequest[] = [];
  let devices = 0;
  let sessions = 0;
  let accessTokens = 0;
  let refreshTokens = 0;

  async function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    if (options.offline) throw new TypeError("fetch failed");
    init.signal?.throwIfAborted();
    const request = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      cookies: parseCookies(new Headers(init.headers).get("cookie")),
      body: typeof init.body === "string" || init.body instanceof URLSearchParams ? String(init.body) : "",
    };
    requests.push(request);
    if (request.url.hostname === ONTRACK) return ontrack(request);
    if (request.url.hostname === OKTA) return okta(request, new Headers(init.headers));
    return new Response("unknown host", { status: 502 });
  }

  function ontrack({ method, url, cookies, body }: RecordedRequest): Response {
    const user = options.ontrackUser ?? ONTRACK_USER;
    if (method === "GET" && url.pathname === "/api/auth/method") {
      return Response.json({ method: "saml", redirect_to: `https://${OKTA}${APP_PATH}` });
    }
    if (method === "POST" && url.pathname === "/api/auth/jwt") {
      if (new URLSearchParams(body).get("SAMLResponse") !== SAML_RESPONSE) return new Response("unauthorized", { status: 401 });
      return redirect(options.noAuthToken ? `${BASE_URL}/home?error=1` : `${BASE_URL}/sign_in?authToken=${AUTH_TOKEN}&username=${user}`);
    }
    if (method === "GET" && (url.pathname === "/sign_in" || url.pathname === "/home")) return html("<app-root></app-root>");
    if (method === "POST" && url.pathname === "/api/auth") {
      const json = JSON.parse(body) as Record<string, unknown>;
      if (json.auth_token !== AUTH_TOKEN || json.username !== user) return Response.json({ error: "invalid" }, { status: 401 });
      const headers = new Headers({ "content-type": "application/json" });
      if (json.remember === true) {
        const expires = new Date(options.now() + REFRESH_LIFETIME_S * 1_000).toUTCString();
        headers.append("set-cookie", `refresh_token=refresh-${++refreshTokens}; path=/api/auth; expires=${expires}; secure; HttpOnly; SameSite=Strict`);
        headers.append("set-cookie", `username=${user}; path=/api/auth; expires=${expires}; secure; HttpOnly; SameSite=Strict`);
      }
      return new Response(JSON.stringify(session(user)), { status: 200, headers });
    }
    if (method === "POST" && url.pathname === "/api/auth/access-token") {
      if (options.refuseRefresh || !cookies.get("refresh_token")?.startsWith("refresh-")) return Response.json(null, { status: 401 });
      return Response.json(session(cookies.get("username") ?? user));
    }
    return new Response("not found", { status: 404 });
  }

  function session(user: string) {
    return {
      user: { id: 7, username: user, first_name: "Stu", last_name: "Dent", email: `${user}@example.edu` },
      auth_token: `access-${++accessTokens}`,
      auth_token_expiry: new Date(options.now() + 10 * 60 * 1_000).toISOString(),
    };
  }

  async function okta({ method, url, cookies, body }: RecordedRequest, headers: Headers): Promise<Response> {
    const set: string[] = [];
    if (!cookies.has("DT")) set.push(`DT=dt-${++devices}; Path=/; Max-Age=157680000; Secure; HttpOnly`);
    if (method === "GET" && url.pathname === APP_PATH) {
      if (cookies.get("sid")?.startsWith("okta-session-")) return html(samlForm(), set);
      return html(`<script>var stateToken = '${STATE_TOKEN}';</script>`, set);
    }
    if (method === "GET" && url.pathname === "/login/token/redirect") {
      return redirect(`https://${OKTA}${APP_PATH}`, [...set, `sid=okta-session-${++sessions}; Path=/; Secure; HttpOnly`]);
    }
    if (method !== "POST" || headers.get("content-type") !== IDX) return new Response("not found", { status: 404 });
    const json = JSON.parse(body) as Record<string, any>;
    if ((json.stateToken ?? json.stateHandle) !== STATE_TOKEN) return idx(401, { messages: errors("idx.session.expired") });
    switch (url.pathname) {
      case "/idp/idx/introspect":
        return idx(200, identifyState());
      case "/idp/idx/identify":
        if (json.identifier !== USERNAME || json.credentials?.passcode !== PASSWORD) {
          return idx(401, { ...identifyState(), messages: errors("incorrectPassword") });
        }
        return idx(200, challengeState(options.factor ?? "google_otp"));
      case "/idp/idx/challenge/answer":
        if (json.credentials?.passcode !== await totp(TOTP_SECRET, options.now())) {
          return idx(400, { ...challengeState("google_otp"), messages: errors("api.authn.otp.invalid") });
        }
        return idx(200, {
          stateHandle: STATE_TOKEN,
          success: { name: "success-redirect", href: `https://${OKTA}/login/token/redirect?stateToken=${STATE_TOKEN}` },
        });
    }
    return new Response("not found", { status: 404 });
  }

  return { fetch, requests };
}

// IdP-initiated: the form goes straight to Doubtfire's ACS, no RelayState.
function samlForm(): string {
  return `<html><body><form action="${BASE_URL}/api/auth/jwt" method="POST">
<input name="SAMLResponse" type="hidden" value="${SAML_RESPONSE}"/></form></body></html>`;
}

const stateHandle = { name: "stateHandle", required: true, value: STATE_TOKEN, visible: false, mutable: false };

function identifyState() {
  return {
    version: "1.0.0",
    stateHandle: STATE_TOKEN,
    remediation: {
      type: "array",
      value: [{
        name: "identify",
        href: `https://${OKTA}/idp/idx/identify`,
        method: "POST",
        value: [
          { name: "identifier", label: "Username", required: true },
          { name: "credentials", type: "object", required: true, form: { value: [{ name: "passcode", secret: true }] } },
          stateHandle,
        ],
      }],
    },
  };
}

function challengeState(factor: "google_otp" | "phone_number") {
  return {
    version: "1.0.0",
    stateHandle: STATE_TOKEN,
    remediation: {
      type: "array",
      value: [{
        name: "challenge-authenticator",
        relatesTo: ["$.currentAuthenticatorEnrollment"],
        href: `https://${OKTA}/idp/idx/challenge/answer`,
        method: "POST",
        value: [
          { name: "credentials", type: "object", required: true, form: { value: [{ name: "passcode", secret: true }] } },
          stateHandle,
        ],
      }],
    },
    currentAuthenticatorEnrollment: { type: "object", value: { type: "app", key: factor, id: `aut-${factor}` } },
  };
}

function errors(key: string) {
  return { type: "array", value: [{ message: `Error ${key}`, i18n: { key }, class: "ERROR" }] };
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of header?.split("; ") ?? []) {
    const equals = pair.indexOf("=");
    if (equals > 0) cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  return cookies;
}

function withCookies(headers: Headers, cookies: string[]): Headers {
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return headers;
}

function html(body: string, cookies: string[] = []): Response {
  return new Response(body, { status: 200, headers: withCookies(new Headers({ "content-type": "text/html" }), cookies) });
}

function redirect(location: string, cookies: string[] = []): Response {
  return new Response(null, { status: 303, headers: withCookies(new Headers({ location }), cookies) });
}

function idx(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": IDX } });
}
