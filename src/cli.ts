#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";

import { createUi, detectAudience, formatFromArgv, writeOutput } from "@bunizao/cli-kit";

import { OnTrackApplication } from "./application.js";
import { loginAuthenticatedSession, resolveAuthenticatedSession } from "./auth.js";
import { openSystemBrowser } from "./browser.js";
import { authenticationCookieCandidates } from "./browser-cookies.js";
import { executeCli, type ChatSendConfirmation } from "./cli-app.js";
import { loadConfig, resolveBaseUrl, resolveConfigPaths, type Environment } from "./config.js";
import { CliError } from "./errors.js";
import { HttpClient } from "./http.js";
import { OnTrackClient } from "./ontrack.js";
import { relaunchForNodeSqlite } from "./runtime.js";
import { createClock } from "./time.js";
import type { TaskSubmissionPlan } from "./submission.js";
import { VERSION } from "./version.js";

const INTERACTIVE_KEYCHAIN_PROMPT_TIMEOUT_MS = 120_000;

async function promptForBrowserLogin(message: string, signal: AbortSignal): Promise<void> {
  const ui = createUi({ input: process.stdin, output: process.stderr, signal });
  if (!ui.interactive) throw new CliError("auth", "Interactive browser login requires a terminal.");
  if (!await ui.confirm(message, { initial: true }).catch(rethrowAsOnTrack)) throw new CliError("cancellation", "Sign-in cancelled.");
}

/** Show the plan of a write, then ask. Only a person at a terminal is asked; anyone else needs --yes. */
async function askToContinue(plan: string, unavailableMessage: string, signal: AbortSignal): Promise<boolean> {
  const ui = createUi({ input: process.stdin, output: process.stderr, signal });
  if (!ui.interactive) throw new CliError("usage", unavailableMessage);
  ui.note(plan, "Plan");
  return ui.confirm("Continue?").catch(rethrowAsOnTrack);
}

// cli-kit reports Ctrl+C inside a prompt with its own error class; OnTrack has its own codes.
function rethrowAsOnTrack(error: unknown): never {
  const code = error instanceof Error && error.name === "CliError" ? (error as { code?: string }).code : undefined;
  if (code === "cancelled") throw new CliError("cancellation", "Cancelled.");
  throw error;
}

function confirmChatSend(details: ChatSendConfirmation, signal: AbortSignal): Promise<boolean> {
  return askToContinue(
    `Send this OnTrack chat message to project ${details.projectId}, task ${details.task}?\n${JSON.stringify(details.message)}`,
    "Chat sending requires an interactive terminal or --yes after explicit user confirmation.",
    signal,
  );
}

function confirmTaskSubmit(plan: TaskSubmissionPlan, signal: AbortSignal): Promise<boolean> {
  const files = plan.uploads.map((upload, index) => `${index + 1}. ${upload.requirementName} (${upload.requirementType}, ${upload.bytes.length} bytes): ${upload.path}`).join("\n");
  return askToContinue(
    `Submit task ${plan.task} in project ${plan.projectId} as ${plan.type}?\n${files}\nTurnitin EULA accepted: ${plan.acceptTiiEula ? "yes" : "no"}`,
    "Task submission requires an interactive terminal or --yes after explicit user confirmation.",
    signal,
  );
}

function confirmMutation(summary: string, signal: AbortSignal): Promise<boolean> {
  return askToContinue(summary, "Mutation requires an interactive terminal or --yes.", signal);
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

function applicationResolver(signal: AbortSignal, env: Environment, platform: NodeJS.Platform): () => Promise<OnTrackApplication> {
  let application: Promise<OnTrackApplication> | undefined;
  return () => {
    application ??= createApplication(signal, env, platform);
    return application;
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
  const browserCookieProvider = async () => {
    const warnings: string[] = [];
    const candidates = await authenticationCookieCandidates(baseUrl, {
      keychainPromptTimeoutMs: INTERACTIVE_KEYCHAIN_PROMPT_TIMEOUT_MS,
      onWarning: (warning) => warnings.push(warning),
    });
    if (candidates.length > 0) return candidates;
    // No readable browser session (locked cookies, no Keychain/FDA, or not signed in yet).
    // Fall through to the loopback sign-in below instead of forcing a Files & Folders grant.
    if (warnings.some((warning) => !warning.endsWith("cookies database not found."))) {
      process.stderr.write("Browser cookie warning: Direct browser-cookie reuse is unavailable. Continuing with loopback sign-in.\n");
    }
    return candidates;
  };
  const session = await loginAuthenticatedSession({
    baseUrl,
    sessionFile: paths.sessionFile,
    signal,
    browserCookieProvider,
    onLoginUrl: (url) => { process.stderr.write(`Sign-in URL: ${url}\n`); },
    onConsoleSnippet: (snippet) => {
      process.stderr.write(
        `\nAfter signing in, open the OnTrack tab (${baseUrl}), launch DevTools`
        + " (Cmd+Opt+J on macOS, Ctrl+Shift+J elsewhere), and paste this once"
        + " (Chrome may ask you to type \"allow pasting\" first):\n\n"
        + `${snippet}\n\n`,
      );
    },
    onBrowserWait: (timeoutMs) => {
      process.stderr.write(`Waiting up to ${Math.ceil(timeoutMs / 1_000)} seconds for the browser to hand back your session. Press Ctrl-C to cancel.\n`);
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
    // --verbose is the flag you reach for when a command feels slow, so it reports
    // the requests and their timings. Never the token: it is a header.
    ...(process.argv.includes("--verbose")
      ? { trace: (entry) => process.stderr.write(`${entry.method} ${entry.url} ${entry.status} ${entry.ms}ms\n`) }
      : {}),
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
      application: applicationResolver(controller.signal, env, platform),
      authLogin: () => authLogin(controller.signal, env, platform),
      authLogout: () => authLogout(env, platform),
      confirmChatSend: (details) => confirmChatSend(details, controller.signal),
      confirmTaskSubmit: (plan) => confirmTaskSubmit(plan, controller.signal),
      confirmMutation: (summary) => confirmMutation(summary, controller.signal),
      interactive: process.stdin.isTTY === true,
      // One rule for who is on the other end: a person at a terminal reading a table gets
      // asked for what they left out; a pipe, --json or an agent's shell gets the usage error.
      ui: createUi({
        input: process.stdin,
        output: process.stderr,
        signal: controller.signal,
        interactive: detectAudience({ stdin: process.stdin, stdout: process.stdout, env, format: formatFromArgv(argv, process.stdout.isTTY === true) }) === "human",
      }),
      stdoutIsTty: process.stdout.isTTY === true,
      // A pty that will not report its size still needs a table narrow enough to read.
      ...(terminalWidth() === undefined ? {} : { stdoutColumns: terminalWidth() as number }),
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

function terminalWidth(): number | undefined {
  return process.stdout.columns || (process.stdout.isTTY ? 80 : undefined);
}

process.exitCode = await relaunchForNodeSqlite() ?? await main();
