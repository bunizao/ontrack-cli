#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { OnTrackApplication } from "./application.js";
import { loginAuthenticatedSession, resolveAuthenticatedSession } from "./auth.js";
import { openSystemBrowser } from "./browser.js";
import { browserCookieCandidates } from "./browser-cookies.js";
import { executeCli, type CliApplication } from "./cli-app.js";
import { loadConfig, resolveBaseUrl, resolveConfigPaths, type Environment } from "./config.js";
import { CliError } from "./errors.js";
import { HttpClient } from "./http.js";
import { OnTrackClient } from "./ontrack.js";
import { createClock } from "./time.js";
import { VERSION } from "./version.js";

async function promptForBrowserLogin(message: string, signal: AbortSignal): Promise<void> {
  if (!process.stdin.isTTY) throw new CliError("auth", "Interactive browser login requires a terminal.");
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    await prompt.question(`${message} `, { signal });
  } finally {
    prompt.close();
  }
}

function lazyApplication(signal: AbortSignal, env: Environment, platform: NodeJS.Platform): CliApplication {
  let application: Promise<OnTrackApplication> | undefined;
  const resolve = (): Promise<OnTrackApplication> => {
    application ??= createApplication(signal, env, platform);
    return application;
  };
  return {
    user: async () => (await resolve()).user(),
    authCheck: async () => (await resolve()).authCheck(),
    projects: async (options) => (await resolve()).projects(options),
    project: async (projectId) => (await resolve()).project(projectId),
    tasks: async (projectId, options) => (await resolve()).tasks(projectId, options),
    roles: async (options) => (await resolve()).roles(options),
  };
}

async function authLogin(signal: AbortSignal, env: Environment, platform: NodeJS.Platform): Promise<unknown> {
  const cwd = process.cwd();
  const paths = resolveConfigPaths({
    env,
    platform,
    homeDir: homedir(),
    cwd,
    cwdConfigExists: existsSync(join(cwd, "config.yaml")),
  });
  const config = loadConfig(paths);
  const baseUrl = resolveBaseUrl(env, config);
  const shownWarnings = new Set<string>();
  const showWarning = (warning: string): void => {
    if (shownWarnings.has(warning)) return;
    shownWarnings.add(warning);
    process.stderr.write(`Browser cookie warning: ${warning}\n`);
  };
  const session = await loginAuthenticatedSession({
    baseUrl,
    sessionFile: paths.sessionFile,
    signal,
    browserCookieProvider: () => browserCookieCandidates(baseUrl, { onWarning: showWarning }),
    promptEnter: (message) => promptForBrowserLogin(message, signal),
    openBrowser: (url) => openSystemBrowser(url, { platform }),
  });
  return {
    username: session.username,
    auth_token_expiry: session.authTokenExpiry,
  };
}

async function createApplication(signal: AbortSignal, env: Environment, platform: NodeJS.Platform): Promise<OnTrackApplication> {
  const cwd = process.cwd();
  const paths = resolveConfigPaths({
    env,
    platform,
    homeDir: homedir(),
    cwd,
    cwdConfigExists: existsSync(join(cwd, "config.yaml")),
  });
  const config = loadConfig(paths);
  const baseUrl = resolveBaseUrl(env, config);
  let session = await resolveAuthenticatedSession({
    baseUrl,
    sessionFile: paths.sessionFile,
    env,
    config,
    signal,
    browserCookieProvider: () => browserCookieCandidates(baseUrl),
  });
  const sessionState = { current: session };
  const http = new HttpClient({
    baseUrl,
    credentials: { username: session.username, accessToken: session.accessToken },
    signal,
    refresh: async (refreshSignal) => {
      session = await resolveAuthenticatedSession({
        baseUrl,
        sessionFile: paths.sessionFile,
        env,
        config,
        signal: refreshSignal,
        skipCache: true,
        browserCookieProvider: () => browserCookieCandidates(baseUrl),
      });
      sessionState.current = session;
      return { username: session.username, accessToken: session.accessToken };
    },
  });
  return new OnTrackApplication(sessionState, new OnTrackClient(http), createClock(env.ONTRACK_NOW));
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const env = process.env;
  const platform = process.platform;
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once("SIGINT", cancel);
  if (platform === "win32") process.once("SIGBREAK", cancel);
  try {
    const result = await executeCli(argv, {
      app: lazyApplication(controller.signal, env, platform),
      authLogin: () => authLogin(controller.signal, env, platform),
      version: VERSION,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exitCode;
  } finally {
    process.removeListener("SIGINT", cancel);
    if (platform === "win32") process.removeListener("SIGBREAK", cancel);
  }
}

process.exitCode = await main();
