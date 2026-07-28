import assert from "node:assert/strict";

import { loginInOwnedBrowser, type OwnedBrowserLauncher } from "../src/interactive-browser.js";

export async function test_owned_browser_login_returns_ontrack_cookies_without_browser_database_access(): Promise<void> {
  const events: string[] = [];
  let reads = 0;
  const launch: OwnedBrowserLauncher = async (url) => {
    events.push(`launch:${url}`);
    return {
      cookies: async (cookieUrl) => {
        reads += 1;
        events.push(`cookies:${cookieUrl}:${reads}`);
        return reads === 1 ? [] : [
          { name: "username", value: "alice", domain: "school.example.edu", path: "/api/auth" },
          { name: "refresh_token", value: "refresh", domain: "school.example.edu", path: "/api/auth" },
        ];
      },
      close: async () => { events.push("close"); },
    };
  };

  const candidates = await loginInOwnedBrowser(
    "https://school.example.edu/sign_in",
    "https://school.example.edu",
    { launch, pollIntervalMs: 0 },
  );

  assert.equal(candidates[0]?.source, "interactive-browser");
  assert.deepEqual(candidates[0]?.cookies.map((cookie) => cookie.name), ["username", "refresh_token"]);
  assert.deepEqual(events, [
    "launch:https://school.example.edu/sign_in",
    "cookies:https://school.example.edu/api/auth/access-token:1",
    "cookies:https://school.example.edu/api/auth/access-token:2",
    "close",
  ]);
}
