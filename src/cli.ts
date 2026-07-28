#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { unlink } from "node:fs/promises";

import { writeOutput } from "@bunizao/cli-kit";

import { OnTrackApplication } from "./application.js";
import { loginAuthenticatedSession, resolveAuthenticatedSession } from "./auth.js";
import { openSystemBrowser } from "./browser.js";
import { authenticationCookieCandidates } from "./browser-cookies.js";
import { executeCli, type ChatSendConfirmation, type CliApplication } from "./cli-app.js";
import { loadConfig, resolveBaseUrl, resolveConfigPaths, type Environment } from "./config.js";
import { CliError } from "./errors.js";
import { HttpClient } from "./http.js";
import { loginInOwnedBrowser } from "./interactive-browser.js";
import { OnTrackClient } from "./ontrack.js";
import { relaunchForNodeSqlite } from "./runtime.js";
import { createClock } from "./time.js";
import type { TaskSubmissionPlan } from "./submission.js";
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

async function terminalAnswer(question: string, unavailableMessage: string, signal: AbortSignal): Promise<string> {
  if (!process.stdin.isTTY) throw new CliError("usage", unavailableMessage);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await prompt.question(question, { signal });
  } finally {
    prompt.close();
  }
}

async function confirmChatSend(details: ChatSendConfirmation, signal: AbortSignal): Promise<boolean> {
  const message = JSON.stringify(details.message);
  const answer = await terminalAnswer(
    `Send this OnTrack chat message to project ${details.projectId}, task ${details.task}?\n${message}\nContinue? y/N `,
    "Chat sending requires an interactive terminal or --yes after explicit user confirmation.",
    signal,
  );
  return answer.trim().toLowerCase() === "y";
}

async function confirmTaskSubmit(plan: TaskSubmissionPlan, signal: AbortSignal): Promise<boolean> {
  const files = plan.uploads.map((upload, index) => `  ${index + 1}. ${upload.requirementName} (${upload.requirementType}, ${upload.bytes.length} bytes): ${upload.path}`).join("\n");
  const answer = await terminalAnswer(
    `Submit task ${plan.task} in project ${plan.projectId} as ${plan.type}?\n${files}\nTurnitin EULA accepted: ${plan.acceptTiiEula ? "yes" : "no"}\nContinue? y/N `,
    "Task submission requires an interactive terminal or --yes after explicit user confirmation.",
    signal,
  );
  return answer.trim().toLowerCase() === "y";
}

async function confirmMutation(summary: string, signal: AbortSignal): Promise<boolean> {
  const answer = await terminalAnswer(`${summary}\nContinue? y/N `, "Mutation requires an interactive terminal or --yes.", signal);
  return answer.trim().toLowerCase() === "y";
}

async function authLogout(env: Environment, platform: NodeJS.Platform): Promise<unknown> {
  const cwd = process.cwd();
  const paths = resolveConfigPaths({
    env,
    platform,
    homeDir: homedir(),
    cwd,
    cwdConfigExists: existsSync(join(cwd, "config.yaml")),
  });
  await unlink(paths.sessionFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  return { logged_out: true };
}

function lazyApplication(signal: AbortSignal, env: Environment, platform: NodeJS.Platform): CliApplication {
  let application: Promise<OnTrackApplication> | undefined;
  const resolve = (): Promise<OnTrackApplication> => {
    application ??= createApplication(signal, env, platform);
    return application;
  };
  return {
    resolveProject: async (reference) => (await resolve()).resolveProject(reference),
    user: async () => (await resolve()).user(),
    authCheck: async () => (await resolve()).authCheck(),
    projects: async (options) => (await resolve()).projects(options),
    project: async (projectId) => (await resolve()).project(projectId),
    tasks: async (projectId, options) => (await resolve()).tasks(projectId, options),
    taskShow: async (projectId, task) => (await resolve()).taskShow(projectId, task),
    resourcesDownload: async (projectId, options) => (await resolve()).resourcesDownload(projectId, options),
    taskSheetDownload: async (projectId, task, options) => (await resolve()).taskSheetDownload(projectId, task, options),
    taskResourcesDownload: async (projectId, task, options) => (await resolve()).taskResourcesDownload(projectId, task, options),
    taskRead: async (projectId, task) => (await resolve()).taskRead(projectId, task),
    taskState: async (projectId, task, state) => (await resolve()).taskState(projectId, task, state),
    prepareTaskSubmission: async (projectId, task, options) => (await resolve()).prepareTaskSubmission(projectId, task, options),
    submitTask: async (plan) => (await resolve()).submitTask(plan),
    chats: async (projectId, options) => (await resolve()).chats(projectId, options),
    chatMarkRead: async (projectId, task) => (await resolve()).chatMarkRead(projectId, task),
    prepareChatSend: async (projectId, task, message) => (await resolve()).prepareChatSend(projectId, task, message),
    chatSend: async (plan) => (await resolve()).chatSend(plan),
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
    signal,
    browserCookieProvider: () => authenticationCookieCandidates(baseUrl, { includeBrowsers: false }),
    activeLogin: (url) => {
      process.stderr.write("Opening a temporary Chrome window for OnTrack sign-in.\n");
      return loginInOwnedBrowser(url, baseUrl, { signal });
    },
    onLoginUrl: (url) => { process.stderr.write(`Sign-in URL: ${url}\n`); },
    onBrowserWait: (timeoutMs) => {
      process.stderr.write(`Waiting up to ${Math.ceil(timeoutMs / 1_000)} seconds for a reusable browser session (Remember me must be enabled). Press Ctrl-C to cancel.\n`);
    },
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
    browserCookieProvider: () => authenticationCookieCandidates(baseUrl),
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
        browserCookieProvider: () => authenticationCookieCandidates(baseUrl),
      });
      sessionState.current = session;
      return { username: session.username, accessToken: session.accessToken };
    },
  });
  return new OnTrackApplication(sessionState, new OnTrackClient(http), createClock(env.ONTRACK_NOW), signal);
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
      authLogout: () => authLogout(env, platform),
      confirmChatSend: (details) => confirmChatSend(details, controller.signal),
      confirmTaskSubmit: (plan) => confirmTaskSubmit(plan, controller.signal),
      confirmMutation: (summary) => confirmMutation(summary, controller.signal),
      interactive: process.stdin.isTTY === true,
      stdoutIsTty: process.stdout.isTTY === true,
      runtime: {
        nodeVersion: process.versions.node,
        ...(Reflect.get(process.versions, "bun") ? { bunVersion: String(Reflect.get(process.versions, "bun")) } : {}),
      },
      onDiagnostic: (message) => { process.stderr.write(message); },
      version: VERSION,
    });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) await writeOutput(result.stdout, result.output ? { output: result.output } : {});
    return result.exitCode;
  } finally {
    process.removeListener("SIGINT", cancel);
    if (platform === "win32") process.removeListener("SIGBREAK", cancel);
  }
}

process.exitCode = await relaunchForNodeSqlite() ?? await main();
