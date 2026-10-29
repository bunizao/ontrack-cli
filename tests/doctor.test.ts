import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diagnoseAuth } from "../src/doctor.js";
import { CliError } from "../src/errors.js";
import { writeSessionCache } from "../src/session-cache.js";

export async function test_doctor_reports_encryption_and_renewal_without_credentials(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-doctor-"));
  const sessionFile = join(directory, "session.json");
  const key = { encryptionKey: async () => Buffer.alloc(32, 7) };
  try {
    await writeSessionCache(sessionFile, {
      base_url: "https://school.example.edu", username: "alice", access_token: "private-access",
      auth_token_expiry: "2030-01-01T00:00:00Z", provenance: "browser",
      refresh_cookies: [{ name: "refresh_token", value: "private-refresh", domain: "school.example.edu" }],
    }, key);
    const report = await diagnoseAuth({
      ...key, baseUrl: "https://school.example.edu", sessionFile, env: {}, nodeVersion: "24.0.0",
      findBrowser: async () => ({ path: "/test/chrome", name: "Test Chrome" }),
      fetch: async () => Response.json({ method: "saml", redirect_to: "https://identity.example.edu/saml" }),
      liveCheck: async () => ({ projects: 2, unit_roles: 0, auth_token: "private-access" }),
      cookieProbe: async () => ({ profiles: 0, warnings: ["Browser data access is denied."] }),
    });
    const auth = report.auth as Record<string, unknown>;
    assert.equal(auth.cache_encrypted, true);
    assert.equal(auth.renewal, "refresh_cookie");
    assert.deepEqual(report.live_session, { authenticated: true, projects: 2, unit_roles: 0 });
    assert.doesNotMatch(JSON.stringify(report), /private-access|private-refresh|encrypted_session/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function test_doctor_keeps_an_expired_session_failure_actionable(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-doctor-empty-"));
  try {
    const report = await diagnoseAuth({
      baseUrl: "https://school.example.edu", sessionFile: join(directory, "missing.json"), env: {}, nodeVersion: "24.0.0",
      findBrowser: async () => null,
      fetch: async () => new Response(null, { status: 503 }),
      liveCheck: async () => { throw new CliError("auth", "Session expired."); },
    });
    assert.equal((report.site as { reachable: boolean }).reachable, false);
    assert.equal((report.live_session as { authenticated: boolean }).authenticated, false);
    assert.match(String(report.recovery), /discovery is unavailable/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
