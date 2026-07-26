#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { OnTrackApplication } from "./application.js";
import { resolveAuthenticatedSession } from "./auth.js";
import { executeCli, type CliApplication } from "./cli-app.js";
import { loadConfig, resolveBaseUrl, resolveConfigPaths } from "./config.js";
import { HttpClient } from "./http.js";
import { OnTrackClient } from "./ontrack.js";
import { createClock } from "./time.js";
import { VERSION } from "./version.js";

function lazyApplication(signal: AbortSignal): CliApplication {
  let application: Promise<OnTrackApplication> | undefined;
  const resolve = (): Promise<OnTrackApplication> => {
    application ??= createApplication(signal);
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

async function createApplication(signal: AbortSignal): Promise<OnTrackApplication> {
  const env = process.env;
  const cwd = process.cwd();
  const paths = resolveConfigPaths({
    env,
    platform: process.platform,
    homeDir: homedir(),
    cwd,
    cwdConfigExists: existsSync(join(cwd, "config.yaml")),
  });
  const config = loadConfig(paths);
  const baseUrl = resolveBaseUrl(env, config);
  let session = await resolveAuthenticatedSession({
    baseUrl,
    configDir: paths.configDir,
    env,
    config,
    signal,
  });
  const http = new HttpClient({
    baseUrl,
    credentials: { username: session.username, accessToken: session.accessToken },
    signal,
    refresh: async (refreshSignal) => {
      session = await resolveAuthenticatedSession({
        baseUrl,
        configDir: paths.configDir,
        env,
        config,
        signal: refreshSignal,
        skipCache: true,
      });
      return { username: session.username, accessToken: session.accessToken };
    },
  });
  return new OnTrackApplication(session, new OnTrackClient(http), createClock(env.ONTRACK_NOW));
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const result = await executeCli(argv, {
      app: lazyApplication(controller.signal),
      version: VERSION,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.exitCode;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

process.exitCode = await main();
