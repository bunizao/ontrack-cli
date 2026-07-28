import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserCookie, BrowserCookieCandidate } from "./browser-cookies.js";
import { CliError } from "./errors.js";

const REQUIRED_COOKIES = ["username", "refresh_token"] as const;

export interface OwnedBrowserSession {
  readonly cookies: (url: string) => Promise<readonly BrowserCookie[]>;
  readonly close: () => Promise<void>;
}

export type OwnedBrowserLauncher = (url: string) => Promise<OwnedBrowserSession>;

export interface InteractiveBrowserLoginOptions {
  readonly launch?: OwnedBrowserLauncher;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export async function loginInOwnedBrowser(
  signInUrl: string,
  baseUrl: string,
  options: InteractiveBrowserLoginOptions = {},
): Promise<readonly BrowserCookieCandidate[]> {
  const launch = options.launch ?? launchChrome;
  const session = await launch(signInUrl);
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  const cookieUrl = new URL("/api/auth/access-token", baseUrl).href;
  try {
    while (true) {
      if (options.signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
      const cookies = await session.cookies(cookieUrl);
      const required = REQUIRED_COOKIES.map((name) => cookies.find((cookie) => cookie.name === name));
      if (required.every((cookie) => cookie !== undefined)) {
        return [{ source: "interactive-browser", cookies: required as BrowserCookie[] }];
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new CliError("auth", "Interactive OnTrack sign-in timed out.");
      await wait(Math.min(options.pollIntervalMs ?? 500, remainingMs), options.signal);
    }
  } finally {
    await session.close();
  }
}

async function launchChrome(url: string): Promise<OwnedBrowserSession> {
  const profileDirectory = await mkdtemp(join(tmpdir(), "ontrack-login-"));
  try {
    const context = await chromium.launchPersistentContext(profileDirectory, {
      channel: "chrome",
      headless: false,
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    return {
      cookies: (cookieUrl) => context.cookies(cookieUrl),
      close: async () => {
        await context.close();
        await rm(profileDirectory, { force: true, recursive: true });
      },
    };
  } catch (error) {
    await rm(profileDirectory, { force: true, recursive: true });
    throw error;
  }
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CliError("cancellation", "Authentication cancelled."));
  return new Promise((resolve, reject) => {
    const cancel = (): void => {
      clearTimeout(timer);
      reject(new CliError("cancellation", "Authentication cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
