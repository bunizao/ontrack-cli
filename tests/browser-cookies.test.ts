import assert from "node:assert/strict";

import { ALL_PROFILES, type GetCookiesOptions, type GetCookiesResult } from "@steipete/sweet-cookie";

import { browserCookieCandidates, type CookieExtractor } from "../src/browser-cookies.js";

export async function test_browser_cookie_discovery_reads_supported_browsers_and_all_profiles(): Promise<void> {
  const received: GetCookiesOptions[] = [];
  const getCookies: CookieExtractor = async (options) => {
    received.push(options);
    return { cookies: [], warnings: [] };
  };

  await browserCookieCandidates("https://ontrack.example.edu", { getCookies, platform: "darwin" });

  assert.deepEqual(received.map((options) => options.browsers), [
    ["chrome"], ["edge"], ["firefox"], ["safari"],
  ]);
  for (const options of received) {
    assert.equal(options.url, "https://ontrack.example.edu/api/auth/access-token");
    assert.deepEqual(options.names, ["username", "refresh_token"]);
    assert.equal(options.chromeProfile, ALL_PROFILES);
    assert.equal(options.edgeProfile, ALL_PROFILES);
    assert.equal(options.firefoxProfile, ALL_PROFILES);
  }
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
