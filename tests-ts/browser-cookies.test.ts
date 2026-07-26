import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import {
  browserCookieCandidates,
  type BrowserCookie,
  type CookieFileReader,
  type ExecFile,
} from "../src/browser-cookies.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ontrack-browser-cookies-test-"));
}

async function touch(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "fixture", "utf8");
}

const validCookies: readonly BrowserCookie[] = [
  { name: "username", value: "alice", domain: ".example.edu", path: "/api/auth", secure: true },
  { name: "refresh_token", value: "refresh", domain: ".example.edu", path: "/api/auth", secure: true },
];

function encryptedChromiumCookie(domain: string, value: string, password: string): string {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plaintext = Buffer.concat([createHash("sha256").update(domain).digest(), Buffer.from(value)]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plaintext), cipher.final()]).toString("hex");
}

export async function test_chromium_profiles_are_discovered_and_kept_separate(): Promise<void> {
  const homeDir = await temporaryDirectory();
  const chromeRoot = join(homeDir, "Library/Application Support/Google/Chrome");
  const braveRoot = join(homeDir, "Library/Application Support/BraveSoftware/Brave-Browser");
  const edgeRoot = join(homeDir, "Library/Application Support/Microsoft Edge");
  await touch(join(chromeRoot, "Default/Network/Cookies"));
  await touch(join(chromeRoot, "Profile 2/Cookies"));
  await touch(join(chromeRoot, "System Profile/Network/Cookies"));
  await touch(join(braveRoot, "Guest Profile/Network/Cookies"));
  await touch(join(edgeRoot, "Default/Network/Cookies"));

  const reads: string[] = [];
  const chromiumCookieReader: CookieFileReader = async (requestUrl, cookieFile) => {
    assert.equal(requestUrl, "https://ontrack.example.edu/api/auth/access-token");
    reads.push(cookieFile);
    const profile = cookieFile.includes("Profile 2") ? "bob" : cookieFile.includes("Brave") ? "brave" : cookieFile.includes("Edge") ? "edge" : "alice";
    return validCookies.map((cookie) => cookie.name === "username" ? { ...cookie, value: profile } : cookie);
  };

  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    homeDir,
    platform: "darwin",
    chromiumCookieReader,
    firefoxCookieReader: async () => [],
  });

  assert.deepEqual(candidates.map((candidate) => candidate.source), [
    "Chrome:Default",
    "Chrome:Profile 2",
    "Brave:Guest Profile",
    "Edge:Default",
  ]);
  assert.equal(reads.length, 4);
  assert.deepEqual(candidates.map((candidate) => candidate.cookies.find((cookie) => cookie.name === "username")?.value), [
    "alice", "bob", "brave", "edge",
  ]);
}

export async function test_browser_cookie_boundary_keeps_only_a_valid_pair(): Promise<void> {
  const homeDir = await temporaryDirectory();
  await touch(join(homeDir, "Library/Application Support/Google/Chrome/Default/Network/Cookies"));
  const chromiumCookieReader: CookieFileReader = async () => [
    ...validCookies,
    { name: "unrelated", value: "secret", domain: ".example.edu", path: "/" },
    { name: "refresh_token", value: "wrong-domain", domain: ".evil.example", path: "/api/auth" },
    { name: "username", value: "wrong-path", domain: ".example.edu", path: "/account" },
    { name: "refresh_token", value: "expired", domain: ".example.edu", path: "/api/auth", expires: 1 },
    { name: "refresh_token", value: "newline\n", domain: ".example.edu", path: "/api/auth" },
  ];

  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    homeDir,
    platform: "darwin",
    now: new Date("2026-01-01T00:00:00Z"),
    chromiumCookieReader,
    firefoxCookieReader: async () => [],
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]?.cookies.map(({ name, value }) => [name, value]), [
    ["username", "alice"],
    ["refresh_token", "refresh"],
  ]);
}

export async function test_host_only_browser_cookies_do_not_match_a_subdomain(): Promise<void> {
  const homeDir = await temporaryDirectory();
  await touch(join(homeDir, "Library/Application Support/Google/Chrome/Default/Network/Cookies"));
  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    homeDir,
    platform: "darwin",
    chromiumCookieReader: async () => [
      { name: "username", value: "alice", domain: "example.edu", path: "/api/auth" },
      { name: "refresh_token", value: "refresh", domain: "example.edu", path: "/api/auth" },
    ],
    firefoxCookieReader: async () => [],
  });

  assert.deepEqual(candidates, []);
}

export async function test_incomplete_or_failed_profile_is_skipped_without_mixing(): Promise<void> {
  const homeDir = await temporaryDirectory();
  await touch(join(homeDir, "Library/Application Support/Google/Chrome/Default/Network/Cookies"));
  await touch(join(homeDir, "Library/Application Support/Google/Chrome/Profile 1/Network/Cookies"));
  const chromiumCookieReader: CookieFileReader = async (_url, path) => {
    if (path.includes("Default")) return [validCookies[0]!];
    throw new Error("profile is locked");
  };

  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    homeDir,
    platform: "darwin",
    chromiumCookieReader,
    firefoxCookieReader: async () => [],
  });

  assert.deepEqual(candidates, []);
}

export async function test_firefox_uses_readonly_sqlite_json_and_profile_groups(): Promise<void> {
  const homeDir = await temporaryDirectory();
  const first = join(homeDir, "Library/Application Support/Firefox/Profiles/abc.default/cookies.sqlite");
  const second = join(homeDir, "Library/Application Support/Firefox/Profiles/work/cookies.sqlite");
  await touch(first);
  await touch(second);
  const calls: string[][] = [];
  const execFile: ExecFile = async (file, args) => {
    calls.push([file, ...args]);
    return {
      exitCode: 0,
      stdout: JSON.stringify(validCookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expiry: 2_000_000_000,
        secure: 1,
      }))),
      stderr: "",
    };
  };

  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    homeDir,
    platform: "darwin",
    chromiumCookieReader: async () => [],
    execFile,
  });

  assert.deepEqual(candidates.map((candidate) => candidate.source), ["Firefox:abc.default", "Firefox:work"]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call[0] === "sqlite3" && call[1] === "-readonly" && call[2] === "-json"));
  assert.deepEqual(calls.map((call) => call[3]), [first, second]);
  assert.ok(calls.every((call) => call[4]?.includes("username") && call[4]?.includes("refresh_token")));
}

export async function test_macos_chromium_decrypts_synthetic_cookies_without_a_dependency(): Promise<void> {
  const homeDir = await temporaryDirectory();
  const cookieFile = join(homeDir, "Library/Application Support/Google/Chrome/Default/Network/Cookies");
  await touch(cookieFile);
  const password = "deterministic-test-password";
  const domain = ".example.edu";
  const rows = [
    { name: "username", value: "", domain, path: "/api/auth", secure: 1, expires: 2_000_000_000, encrypted_value: encryptedChromiumCookie(domain, "alice", password) },
    { name: "refresh_token", value: "", domain, path: "/api/auth", secure: 1, expires: 2_000_000_000, encrypted_value: encryptedChromiumCookie(domain, "refresh-secret", password) },
  ];
  const calls: string[][] = [];
  const execFile: ExecFile = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "sqlite3") return { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" };
    if (file === "security") return { exitCode: 0, stdout: `${password}\n`, stderr: "" };
    throw new Error("unexpected executable");
  };

  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    homeDir,
    platform: "darwin",
    execFile,
    firefoxCookieReader: async () => [],
  });

  assert.deepEqual(candidates[0]?.cookies.map(({ name, value }) => [name, value]), [
    ["username", "alice"],
    ["refresh_token", "refresh-secret"],
  ]);
  assert.deepEqual(calls.map(([file, ...args]) => [file, ...args.slice(0, 3)]), [
    ["sqlite3", "-readonly", "-json", cookieFile],
    ["security", "find-generic-password", "-w", "-s"],
  ]);
  assert.equal(calls[1]?.[4], "Chrome Safe Storage");
  assert.ok(calls.every((call) => !call.includes(password)));
}

export async function test_default_chromium_reader_is_a_noop_off_macos(): Promise<void> {
  const homeDir = await temporaryDirectory();
  await touch(join(homeDir, ".config/google-chrome/Default/Network/Cookies"));
  let executions = 0;
  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    homeDir,
    platform: "linux",
    execFile: async () => {
      executions += 1;
      throw new Error("must not execute");
    },
    firefoxCookieReader: async () => [],
  });
  assert.deepEqual(candidates, []);
  assert.equal(executions, 0);
}

export async function test_missing_optional_readers_are_harmless(): Promise<void> {
  const homeDir = await temporaryDirectory();
  await touch(join(homeDir, "Library/Application Support/Google/Chrome/Default/Network/Cookies"));
  await touch(join(homeDir, "Library/Application Support/Firefox/Profiles/default/cookies.sqlite"));

  const candidates = await browserCookieCandidates("https://ontrack.example.edu", {
    homeDir,
    platform: "darwin",
    chromiumCookieReader: async () => { throw new Error("optional dependency unavailable"); },
    execFile: async () => { throw Object.assign(new Error("sqlite3 unavailable"), { code: "ENOENT" }); },
  });

  assert.deepEqual(candidates, []);
}
