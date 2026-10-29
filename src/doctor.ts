import { localAuthStatus, type ResolveAuthenticatedSessionOptions } from "./auth.js";
import { findChromiumBrowser, type ChromiumBrowser } from "./cdp-login.js";
import { CliError } from "./errors.js";

export interface DoctorOptions extends ResolveAuthenticatedSessionOptions {
  readonly nodeVersion: string;
  readonly bunVersion?: string;
  readonly findBrowser?: () => Promise<ChromiumBrowser | null>;
  readonly liveCheck?: () => Promise<unknown>;
  readonly cookieProbe?: () => Promise<{ profiles: number; warnings: readonly string[] }>;
}

function errorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof CliError) return { code: error.category, message: error.message };
  return { code: "unknown", message: "The diagnostic check could not complete." };
}

export async function diagnoseAuth(options: DoctorOptions): Promise<Record<string, unknown>> {
  let auth: Record<string, unknown>;
  try { auth = await localAuthStatus(options); }
  catch (error) {
    if (error instanceof CliError && error.category === "cancellation") throw error;
    auth = { error: errorInfo(error) };
  }
  const browser = await (options.findBrowser?.() ?? findChromiumBrowser({
    url: options.baseUrl, isDone: () => false, env: options.env,
    ...(options.platform ? { platform: options.platform } : {}),
  }));
  let site: Record<string, unknown>;
  try {
    const timeout = AbortSignal.timeout(5_000);
    const response = await (options.fetch ?? fetch)(`${options.baseUrl}/api/auth/method`, {
      headers: { Accept: "application/json" }, redirect: "error",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    if (!response.ok) throw new CliError("upstream_api", `Sign-in discovery returned HTTP ${response.status}.`);
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("method" in value) || typeof value.method !== "string") {
      throw new CliError("upstream_contract", "Sign-in discovery returned an invalid method.");
    }
    site = { reachable: true, auth_method: value.method };
  } catch (error) {
    if (options.signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
    site = { reachable: false, error: errorInfo(error) };
  }
  let live: Record<string, unknown> | undefined;
  if (options.liveCheck) {
    try {
      const value = await options.liveCheck();
      const data = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
      live = { authenticated: true, projects: data.projects, unit_roles: data.unit_roles };
    } catch (error) {
      if (error instanceof CliError && error.category === "cancellation") throw error;
      live = { authenticated: false, error: errorInfo(error) };
    }
  }
  let cookies: Record<string, unknown> | undefined;
  if (options.cookieProbe) {
    try { cookies = await options.cookieProbe(); }
    catch (error) {
      if (error instanceof CliError && error.category === "cancellation") throw error;
      cookies = { error: errorInfo(error) };
    }
  }
  return {
    base_url: options.baseUrl,
    runtime: { engine: options.bunVersion ? "bun" : "node", version: options.bunVersion ?? options.nodeVersion },
    browser: { installed: Boolean(browser), name: browser?.name ?? null },
    site, auth,
    ...(live ? { live_session: live } : {}),
    ...(cookies ? { browser_cookies: cookies } : {}),
    recovery: auth.error && (auth.error as { code: string }).code === "config" ? "Fix the credential configuration reported above."
      : auth.error ? "Check the session key store. Unlock or authorize it if access is denied; sign in again if the key was lost."
      : site.reachable === false ? "Sign-in discovery is unavailable. Check the site URL and connection, then retry."
      : auth.credential_source === "environment" || auth.credential_source === "config" || auth.credential_source === "migration"
        ? "Explicit credentials override the cache. Replace or remove an invalid override before signing in through a browser."
        : auth.renewal === "refresh_cookie" || auth.renewal === "browser"
          ? "Run `ontrack auth renew` to verify and renew the session."
          : browser ? "Run `ontrack auth login --browser`." : "Run `ontrack auth login --paste` or `--manual`.",
  };
}
