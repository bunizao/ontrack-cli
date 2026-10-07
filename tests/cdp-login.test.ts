import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { CdpError, findChromiumBrowser, loginWithCdp, type CdpLoginOptions } from "../src/cdp-login.js";

function fakeChrome(options: { ignoreClose?: boolean; ignoreCookies?: boolean; brokenPipe?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdio: [null, null, PassThrough, PassThrough, PassThrough];
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  child.stdio = [null, null, new PassThrough(), toBrowser, fromBrowser];
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", null, "SIGTERM");
    return true;
  };
  const methods: string[] = [];
  const flags: string[][] = [];
  let buffer = "";
  toBrowser.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\0")) !== -1) {
      const message = JSON.parse(buffer.slice(0, index)) as { id: number; method: string };
      buffer = buffer.slice(index + 1);
      methods.push(message.method);
      if (message.method === "Browser.close" && options.ignoreClose) continue;
      if (message.method === "Storage.getCookies") {
        if (options.brokenPipe) {
          queueMicrotask(() => fromBrowser.emit("error", new Error("EPIPE")));
          continue;
        }
        if (options.ignoreCookies) continue;
      }
      const result = message.method === "Storage.getCookies"
        ? { cookies: [{ name: "refresh_token", value: "test-cookie", domain: "school.example.edu", expires: -1 }] }
        : {};
      fromBrowser.write(`${JSON.stringify({ id: message.id, result })}\0`);
    }
  });
  const spawn = ((_path: string, args: string[]) => {
    flags.push(args);
    return child;
  }) as unknown as NonNullable<CdpLoginOptions["spawn"]>;
  return { child, spawn, methods, flags };
}

export async function test_cdp_reads_live_cookies_and_uses_a_private_profile(): Promise<void> {
  const profileDir = await mkdtemp(join(tmpdir(), "ontrack-cdp-test-"));
  const browser = fakeChrome();
  try {
    const result = await loginWithCdp({
      url: "https://school.example.edu",
      profileDir,
      browserPath: "/test/chrome",
      spawn: browser.spawn,
      closeTimeoutMs: 5,
      isDone: (cookies) => cookies.some((cookie) => cookie.name === "refresh_token"),
    });
    assert.equal(result.cookies[0]?.value, "test-cookie");
    assert.equal(result.cookies[0]?.expires, undefined);
    assert.ok(browser.flags[0]?.includes(`--user-data-dir=${profileDir}`));
    assert.ok(browser.flags[0]?.includes("--remote-debugging-pipe"));
    assert.ok(browser.methods.includes("Browser.close"));
    assert.equal(browser.child.killed, true);
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

export async function test_cdp_bounds_unresponsive_cookie_reads_and_closes(): Promise<void> {
  const profileDir = await mkdtemp(join(tmpdir(), "ontrack-cdp-timeout-"));
  const browser = fakeChrome({ ignoreCookies: true, ignoreClose: true });
  try {
    await assert.rejects(loginWithCdp({
      url: "https://school.example.edu", profileDir, browserPath: "/test/chrome", spawn: browser.spawn,
      rpcTimeoutMs: 5, closeTimeoutMs: 5, isDone: () => true,
    }), (error) => error instanceof CdpError && /read cookies/u.test(error.message));
    assert.equal(browser.child.killed, true);
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

export async function test_cdp_terminates_the_browser_after_a_broken_pipe(): Promise<void> {
  const profileDir = await mkdtemp(join(tmpdir(), "ontrack-cdp-pipe-"));
  const browser = fakeChrome({ brokenPipe: true });
  try {
    await assert.rejects(loginWithCdp({
      url: "https://school.example.edu", profileDir, browserPath: "/test/chrome", spawn: browser.spawn,
      isDone: () => true,
    }), CdpError);
    assert.equal(browser.child.killed, true);
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

export async function test_cdp_cancels_a_pending_cookie_read(): Promise<void> {
  const profileDir = await mkdtemp(join(tmpdir(), "ontrack-cdp-cancel-"));
  const browser = fakeChrome({ ignoreCookies: true });
  const controller = new AbortController();
  try {
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await assert.rejects(loginWithCdp({
        url: "https://school.example.edu", profileDir, browserPath: "/test/chrome", spawn: browser.spawn,
        signal: controller.signal, isDone: () => false,
      }), CdpError);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(browser.child.killed, true);
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

export async function test_cdp_discovery_reports_a_missing_browser(): Promise<void> {
  assert.equal(await findChromiumBrowser({ url: "https://school.example.edu", isDone: () => false, platform: "linux", env: { PATH: "" } }), null);
  await assert.rejects(loginWithCdp({
    url: "https://school.example.edu", isDone: () => false, platform: "linux", env: { PATH: "" },
  }), (error) => error instanceof CdpError && /ontrack auth login --paste/u.test(error.hint ?? ""));
}

export async function test_cdp_escalates_when_a_browser_ignores_termination(): Promise<void> {
  const profileDir = await mkdtemp(join(tmpdir(), "ontrack-cdp-kill-"));
  const browser = fakeChrome({ brokenPipe: true });
  const signals: NodeJS.Signals[] = [];
  browser.child.kill = (signal = "SIGTERM") => {
    signals.push(signal);
    browser.child.killed = true;
    if (signal === "SIGKILL") browser.child.emit("exit", null, signal);
    return true;
  };
  try {
    await assert.rejects(loginWithCdp({
      url: "https://school.example.edu", profileDir, browserPath: "/test/chrome", spawn: browser.spawn, isDone: () => true,
    }), CdpError);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}
