// Spike: can a Cloudflare Worker sign in to OnTrack through Okta by itself?
// POST /run with the spike token. The response carries timings, step names and
// digests only, never a token, cookie or credential.
// POST /run?reuse=1 signs in a second time with the Okta session and device token
// the first sign-in returned, to see whether Okta skips the password and code.

import { signInToOnTrack, type OnTrackOktaSession } from "../../src/okta-sign-in.js";

interface Env {
  ONTRACK_ORIGIN: string;
  SPIKE_TOKEN?: string;
  OKTA_USERNAME?: string;
  OKTA_PASSWORD?: string;
  OKTA_TOTP_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/run") return new Response("Not found", { status: 404 });
    if (!env.SPIKE_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.SPIKE_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (!env.OKTA_USERNAME || !env.OKTA_PASSWORD || !env.OKTA_TOTP_SECRET) {
      return Response.json({ ok: false, error: "OKTA_* secrets are not set" }, { status: 412 });
    }
    const credentials = { username: env.OKTA_USERNAME.trim(), password: env.OKTA_PASSWORD, totpSecret: env.OKTA_TOTP_SECRET.trim() };
    const started = Date.now();
    const steps: Array<{ at_ms: number; step: string }> = [];
    const progress = (step: string) => { steps.push({ at_ms: Date.now() - started, step }); };
    const cf = (request as { cf?: Record<string, unknown> }).cf;
    const where = { colo: cf?.colo ?? null, country: cf?.country ?? null };
    try {
      const first = await signInToOnTrack({ baseUrl: env.ONTRACK_ORIGIN, credentials, onProgress: progress });
      const firstReport = await describe(env.ONTRACK_ORIGIN, first);
      let secondReport: Record<string, unknown> | undefined;
      if (url.searchParams.get("reuse") === "1") {
        progress("--- second sign-in with the returned Okta session and device token");
        const second = await signInToOnTrack({
          baseUrl: env.ONTRACK_ORIGIN, credentials, deviceToken: first.deviceToken, oktaSession: first.oktaSession, onProgress: progress,
        });
        secondReport = await describe(env.ONTRACK_ORIGIN, second);
      }
      return Response.json({ ok: true, where, wall_ms: Date.now() - started, steps, first: firstReport, second: secondReport });
    } catch (error) {
      const failure = error as { name?: string; code?: string; message?: string };
      return Response.json({
        ok: false, where, wall_ms: Date.now() - started, steps,
        error: { name: failure.name ?? null, code: failure.code ?? null, message: failure.message ?? String(error) },
      });
    }
  },
};

async function describe(origin: string, session: OnTrackOktaSession): Promise<Record<string, unknown>> {
  const refresh = session.renewalCookies.find((cookie) => cookie.name === "refresh_token")?.value;
  const projects = await fetch(new URL("/api/projects", origin), {
    headers: { Username: session.username, "Auth-Token": session.accessToken },
  });
  return {
    username: session.username,
    auth_token_expiry: session.authTokenExpiry,
    refresh_expires_at: session.refreshExpiresAt?.toISOString() ?? null,
    refresh_token_sha256: refresh ? await sha256Prefix(refresh) : null,
    access_token_works: projects.status,
    device_token: Boolean(session.deviceToken),
    okta_session_cookies: session.oktaSession.length,
  };
}

async function sha256Prefix(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
