#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { OnTrackApplication } from "./application.js";
import { loginAuthenticatedSession, resolveAuthenticatedSession } from "./auth.js";
import { browserCookieCandidates } from "./browser-cookies.js";
import { executeCli, type CliApplication } from "./cli-app.js";
import { loadConfig, resolveBaseUrl, resolveConfigPaths, type Environment } from "./config.js";
import { HttpClient } from "./http.js";
import { OnTrackClient } from "./ontrack.js";
import { createClock } from "./time.js";
import { VERSION } from "./version.js";

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
  const session = await loginAuthenticatedSession({
    baseUrl,
    sessionFile: paths.sessionFile,
    env,
    platform,
    config,
    signal,
    browserCookieProvider: () => browserCookieCandidates(baseUrl, { platform }),
    promptOutput: (text) => process.stderr.write(text),
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
    platform,
    config,
    signal,
    browserCookieProvider: () => browserCookieCandidates(baseUrl, { platform }),
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
        platform,
        config,
        signal: refreshSignal,
        skipCache: true,
        browserCookieProvider: () => browserCookieCandidates(baseUrl, { platform }),
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
