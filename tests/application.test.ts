import assert from "node:assert/strict";

import { OnTrackApplication, type SessionState } from "../src/application.js";
import type { AuthenticatedSession } from "../src/auth.js";
import { CliError } from "../src/errors.js";
import type { HttpClient, HttpRequestOptions } from "../src/http.js";
import { OnTrackClient } from "../src/ontrack.js";
import { createClock } from "../src/time.js";

function session(username: string): AuthenticatedSession {
  return {
    baseUrl: "https://school.example.edu",
    username,
    accessToken: "secret",
    authTokenExpiry: null,
    provenance: "environment",
    user: null,
  };
}

export async function test_user_validates_a_protected_endpoint(): Promise<void> {
  const http = {
    request: async (path: string): Promise<unknown> => {
      if (path === "api/auth/method") return { method: "saml" };
      throw new CliError("auth", "revoked", 401);
    },
  } as HttpClient;
  const app = new OnTrackApplication(
    { current: session("alice") },
    new OnTrackClient(http),
    createClock("2026-07-26T12:00:00Z"),
  );

  await assert.rejects(app.user(), (error) => error instanceof CliError && error.category === "auth");
}

export async function test_application_reads_the_current_session_after_refresh(): Promise<void> {
  const state: SessionState = { current: session("before-refresh") };
  const http = {
    request: async (path: string, options: HttpRequestOptions = {}): Promise<unknown> => {
      if (path === "api/auth/method") return { method: "saml" };
      if (path === "api/projects" && options.query?.include_inactive === true) return [];
      if (path === "api/unit_roles" && options.query?.active_only === false) return [];
      throw new Error(`unexpected request ${path}`);
    },
  } as HttpClient;
  const app = new OnTrackApplication(state, new OnTrackClient(http), createClock("2026-07-26T12:00:00Z"));
  state.current = session("after-refresh");

  assert.deepEqual(await app.user(), {
    username: "after-refresh",
    base_url: "https://school.example.edu",
    auth_method: "saml",
  });
}
