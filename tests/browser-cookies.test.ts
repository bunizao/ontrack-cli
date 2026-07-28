import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALL_PROFILES, type GetCookiesOptions, type GetCookiesResult } from "@steipete/sweet-cookie";

import {
  authenticationCookieCandidates,
  browserCookieCandidates,
  storageStateCookieCandidates,
  type CookieExtractor,
} from "../src/browser-cookies.js";

export async function test_playwright_storage_state_supplies_a_reusable_cookie_pair(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-storage-state-"));
  await Promise.all([
    writeFile(join(directory, "monashuni.okta.com.json"), JSON.stringify({ cookies: [
      { name: "username", value: "alice", domain: "ontrack.example.edu", path: "/api/auth", secure: true, expires: 2_000_000_000 },
      { name: "refresh_token", value: "refresh", domain: "ontrack.example.edu", path: "/api/auth", secure: true, expires: 2_000_000_000 },
      { name: "analytics", value: "ignored", domain: "example.edu", path: "/" },
    ] })),
    writeFile(join(directory, "incomplete.json"), JSON.stringify({ cookies: [
      { name: "username", value: "other", domain: "ontrack.example.edu", path: "/api/auth" },
    ] })),
    writeFile(join(directory, "broken.json"), "not json"),
    writeFile(join(directory, "ignored.meta.json"), JSON.stringify({ cookies: [] })),
  ]);

  assert.deepEqual(await storageStateCookieCandidates(directory), [{
    source: "browser-session:monashuni.okta.com",
    cookies: [
      { name: "username", value: "alice", domain: "ontrack.example.edu", path: "/api/auth", secure: true, expires: 2_000_000_000 },
      { name: "refresh_token", value: "refresh", domain: "ontrack.example.edu", path: "/api/auth", secure: true, expires: 2_000_000_000 },
    ],
  }]);
}

export async function test_authentication_cookie_discovery_prefers_browsers_then_saved_storage_state(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-auth-cookies-"));
  await writeFile(join(directory, "saved.json"), JSON.stringify({ cookies: [
    { name: "username", value: "saved-user", domain: "ontrack.example.edu", path: "/api/auth" },
    { name: "refresh_token", value: "saved-refresh", domain: "ontrack.example.edu", path: "/api/auth" },
  ] }));
  const candidates = await authenticationCookieCandidates("https://ontrack.example.edu", {
    platform: "linux",
    storageStateDirectory: directory,
    getCookies: async (options) => ({
      cookies: options.browsers?.[0] === "chrome" ? [
        { name: "username", value: "chrome-user", domain: "ontrack.example.edu", path: "/api/auth", source: { browser: "chrome" } },
        { name: "refresh_token", value: "chrome-refresh", domain: "ontrack.example.edu", path: "/api/auth", source: { browser: "chrome" } },
      ] : [],
      warnings: [],
    }),
  });

  assert.deepEqual(candidates.map((candidate) => candidate.source), ["chrome:default", "browser-session:saved"]);
}

export async function test_browser_cookie_discovery_reads_supported_browsers_and_all_profiles(): Promise<void> {
  const received: GetCookiesOptions[] = [];
  const getCookies: CookieExtractor = async (options) => {
    received.push(options);
    return { cookies: [], warnings: [] };
  };

  await browserCookieCandidates("https://ontrack.example.edu", { getCookies, platform: "linux" });

  assert.deepEqual(received.map((options) => options.browsers), [
    ["chrome"], ["edge"], ["firefox"],
  ]);
  for (const options of received) {
    assert.equal(options.url, "https://ontrack.example.edu/api/auth/access-token");
    assert.deepEqual(options.names, ["username", "refresh_token"]);
    assert.equal(options.chromeProfile, ALL_PROFILES);
    assert.equal(options.edgeProfile, ALL_PROFILES);
    assert.equal(options.firefoxProfile, ALL_PROFILES);
  }
}

export async function test_macos_chromium_profiles_are_probed_without_reading_the_protected_root(): Promise<void> {
  const received: GetCookiesOptions[] = [];
  await browserCookieCandidates("https://ontrack.example.edu", {
    platform: "darwin",
    homeDir: "/Users/example",
    fileExists: (path) => path.endsWith("/Google/Chrome/Default/Cookies")
      || path.endsWith("/Google/Chrome/Profile 3/Cookies"),
    getCookies: async (options) => {
      received.push(options);
      return { cookies: [], warnings: [] };
    },
  });

  assert.deepEqual(received[0]?.chromeProfile, ["Default", "Profile 3"]);
  assert.equal(received[1]?.edgeProfile, ALL_PROFILES);
  assert.equal(received[2]?.firefoxProfile, ALL_PROFILES);
  assert.deepEqual(received[3]?.browsers, ["safari"]);
}

export async function test_browser_cookie_discovery_keeps_browser_profiles_separate(): Promise<void> {
  const result: GetCookiesResult = {
    cookies: [
      { name: "username", value: "alice", domain: "ontrack.example.edu", path: "/api/auth", source: { browser: "chrome", profile: "Default" } },
      { name: "refresh_token", value: "alice-refresh", domain: "ontrack.example.edu", path: "/api/auth", source: { browser: "chrome", profile: "Default" } },
      { name: "username", value: "bob", domain: "ontrack.example.edu", path: "/api/auth", source: { browser: "firefox", profile: "work" } },
      { name: "refresh_token", value: "bob-refresh", domain: "ontrack.example.edu", path: "/api/auth", source: { browser: "firefox", profile: "work" } },
    ],
    warnings: [],
  };

  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    platform: "linux",
    getCookies: async (options) => ({
      cookies: result.cookies.filter((cookie) => cookie.source?.browser === options.browsers?.[0]),
      warnings: [],
    }),
  });

  assert.deepEqual(candidates.map((candidate) => candidate.source), ["chrome:Default", "firefox:work"]);
  assert.deepEqual(candidates.map((candidate) => candidate.cookies.map(({ name, value }) => [name, value])), [
    [["username", "alice"], ["refresh_token", "alice-refresh"]],
    [["username", "bob"], ["refresh_token", "bob-refresh"]],
  ]);
}

export async function test_browser_cookie_discovery_rejects_a_non_reusable_username_cookie(): Promise<void> {
  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    platform: "linux",
    getCookies: async (options) => ({
      cookies: options.browsers?.[0] === "chrome"
        ? [{ name: "username", value: "alice", domain: "ontrack.example.edu", source: { browser: "chrome" } }]
        : [],
      warnings: [],
    }),
  });

  assert.deepEqual(candidates, []);
}

export async function test_browser_cookie_discovery_keeps_chromium_stores_separate(): Promise<void> {
  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    platform: "darwin",
    getCookies: async (options) => {
      if (options.browsers?.[0] !== "chrome") return { cookies: [], warnings: [] };
      return {
        cookies: [
          { name: "username", value: "chrome-user", domain: "ontrack.example.edu", source: { browser: "chrome", profile: "Default", storeId: "chrome" } },
          { name: "refresh_token", value: "chrome-refresh", domain: "ontrack.example.edu", source: { browser: "chrome", profile: "Default", storeId: "chrome" } },
          { name: "username", value: "brave-user", domain: "ontrack.example.edu", source: { browser: "chrome", profile: "Default", storeId: "brave" } },
          { name: "refresh_token", value: "brave-refresh", domain: "ontrack.example.edu", source: { browser: "chrome", profile: "Default", storeId: "brave" } },
        ],
        warnings: [],
      };
    },
  });

  assert.deepEqual(candidates.map((candidate) => candidate.cookies.map(({ value }) => value)), [
    ["chrome-user", "chrome-refresh"],
    ["brave-user", "brave-refresh"],
  ]);
}

export async function test_browser_cookie_discovery_reports_warnings_without_exposing_cookie_values(): Promise<void> {
  const warnings: string[] = [];
  const getCookies: CookieExtractor = async () => ({
    cookies: [],
    warnings: ["Chrome v20 cookies require the Sweet Cookie extension exporter."],
  });

  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    getCookies,
    platform: "linux",
    onWarning: (warning) => warnings.push(warning),
  });

  assert.deepEqual(candidates, []);
  assert.deepEqual(warnings, ["Chrome v20 cookies require the Sweet Cookie extension exporter."]);
}

export async function test_browser_cookie_discovery_continues_after_one_browser_fails(): Promise<void> {
  const warnings: string[] = [];
  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    platform: "linux",
    onWarning: (warning) => warnings.push(warning),
    getCookies: async (options) => {
      if (options.browsers?.[0] === "chrome") throw new Error("profile is locked");
      if (options.browsers?.[0] !== "firefox") return { cookies: [], warnings: [] };
      return {
        cookies: [
          { name: "username", value: "alice", domain: "ontrack.example.edu", source: { browser: "firefox" } },
          { name: "refresh_token", value: "refresh", domain: "ontrack.example.edu", source: { browser: "firefox" } },
        ],
        warnings: [],
      };
    },
  });

  assert.equal(candidates[0]?.source, "firefox:default");
  assert.deepEqual(warnings, ["Could not read chrome cookies."]);
}

export async function test_browser_cookie_discovery_preserves_permission_failures(): Promise<void> {
  const warnings: string[] = [];
  await browserCookieCandidates("https://ontrack.example.edu", {
    platform: "linux",
    onWarning: (warning) => warnings.push(warning),
    getCookies: async (options) => {
      if (options.browsers?.[0] === "chrome") {
        throw Object.assign(new Error("secret details must not escape"), { code: "EPERM" });
      }
      return { cookies: [], warnings: [] };
    },
  });

  assert.deepEqual(warnings, [
    "Permission denied while reading Chrome cookies (EPERM). Allow the terminal or app that launched ontrack to access browser data, then retry.",
  ]);
  assert.doesNotMatch(warnings.join("\n"), /secret details/u);
}

export async function test_macos_permission_warnings_explain_full_disk_access_without_leaking_paths(): Promise<void> {
  const warnings: string[] = [];
  await browserCookieCandidates("https://ontrack.example.edu", {
    platform: "darwin",
    onWarning: (warning) => warnings.push(warning),
    getCookies: async (options) => ({
      cookies: [],
      warnings: options.browsers?.[0] === "chrome"
        ? ["Failed to copy Chrome cookie DB: EPERM: operation not permitted, copyfile '/Users/private/Cookies' -> '/tmp/private/Cookies'"]
        : [],
    }),
  });

  assert.deepEqual(warnings, [
    "Permission denied while reading Chrome cookies (EPERM). In System Settings > Privacy & Security > Full Disk Access, allow the terminal or app that launched ontrack, then retry.",
  ]);
  assert.doesNotMatch(warnings.join("\n"), /Users|\/tmp/u);
}

export async function test_browser_cookie_discovery_maps_url_only_cookies_to_the_request_host(): Promise<void> {
  const result: GetCookiesResult = {
    cookies: [
      { name: "username", value: "alice", url: "https://ontrack.example.edu", source: { browser: "safari" } },
      { name: "refresh_token", value: "refresh", url: "https://ontrack.example.edu", source: { browser: "safari" } },
    ],
    warnings: [],
  };
  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    platform: "darwin",
    getCookies: async (options) => ({
      cookies: result.cookies.filter((cookie) => cookie.source?.browser === options.browsers?.[0]),
      warnings: [],
    }),
  });

  assert.deepEqual(candidates, [{
    source: "safari:default",
    cookies: [
      { name: "username", value: "alice", domain: "ontrack.example.edu" },
      { name: "refresh_token", value: "refresh", domain: "ontrack.example.edu" },
    ],
  }]);
}
