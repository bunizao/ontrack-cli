import { spawn } from "node:child_process";

import { CliError } from "./errors.js";
import type { OktaCredentials } from "./okta-sign-in.js";

// The Okta credentials live in okta-auth (`okta-auth setup`), not here. Its export
// prints them only into a pipe, never to a terminal; this reads that pipe and
// keeps nothing it prints out of errors.

// npm's okta-auth-cli installs `okta-auth`; the Python package of the same name installs `okta`.
export const OKTA_SETUP = "`okta-auth setup` (`okta setup` with the Python okta-auth-cli)";

const EXPORT_ARGS = ["export", "--dangerously-print-password-and-totp-secret"];
// A password manager may ask the user to approve the read.
const EXPORT_TIMEOUT_MS = 120_000;

export interface OktaExportOptions {
  /** Show okta's own messages (a person is waiting); background renewals drop them. */
  readonly showMessages?: boolean;
  readonly signal?: AbortSignal;
}

/** `okta` (Python okta-auth-cli) first, then `okta-auth` (the TypeScript one). */
export async function exportOktaCredentials(options: OktaExportOptions = {}): Promise<OktaCredentials> {
  let result = await run("okta", options);
  if (result === "missing") result = await run("okta-auth", options);
  if (result === "missing") {
    throw new CliError("config", "Okta sign-in needs the okta command from okta-auth-cli.", undefined,
      `Install it (npm install -g okta-auth-cli), run ${OKTA_SETUP}, then try again.`);
  }
  const credentials = result.code === 0 ? parseOktaExport(result.stdout) : null;
  if (!credentials) {
    throw new CliError("config", "okta export did not print a username, password and TOTP secret.", undefined,
      `Run ${OKTA_SETUP} to store them, then try again.`);
  }
  return credentials;
}

export function parseOktaExport(stdout: string): OktaCredentials | null {
  let payload: unknown;
  try { payload = JSON.parse(stdout); } catch { return null; }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const data = payload as Record<string, unknown>;
  const username = typeof data.OKTA_USERNAME === "string" ? data.OKTA_USERNAME.trim() : "";
  const password = typeof data.OKTA_PASSWORD === "string" ? data.OKTA_PASSWORD : "";
  const totpSecret = typeof data.OKTA_TOTP_SECRET === "string" ? data.OKTA_TOTP_SECRET.trim() : "";
  return username && password && totpSecret ? { username, password, totpSecret } : null;
}

function run(command: string, options: OktaExportOptions): Promise<{ code: number | null; stdout: string } | "missing"> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new CliError("cancellation", "Authentication cancelled."));
      return;
    }
    // stdin is closed so a missing credential fails instead of waiting on a prompt nobody sees.
    // The arguments are constants, so a shell (needed for npm's .cmd shims on Windows) is safe.
    const child = spawn(command, EXPORT_ARGS, {
      stdio: ["ignore", "pipe", options.showMessages ? "inherit" : "ignore"],
      timeout: EXPORT_TIMEOUT_MS,
      shell: process.platform === "win32",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", (error: NodeJS.ErrnoException) => {
      // Ctrl-C while a password manager waits for approval is a cancellation, not missing credentials.
      if (error.name === "AbortError" || options.signal?.aborted) reject(new CliError("cancellation", "Authentication cancelled."));
      else resolve(error.code === "ENOENT" ? "missing" : { code: null, stdout: "" });
    });
    child.on("close", (code) => {
      if (options.signal?.aborted) reject(new CliError("cancellation", "Authentication cancelled."));
      else resolve({ code, stdout });
    });
  });
}
