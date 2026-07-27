import {
  ALL_PROFILES,
  getCookies as extractCookies,
  type Cookie,
  type BrowserName,
  type GetCookiesOptions,
  type GetCookiesResult,
  type ProfileType,
} from "@steipete/sweet-cookie";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";

export interface BrowserCookie {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly expires?: string | number;
}

export interface BrowserCookieCandidate {
  readonly source: string;
  readonly cookies: readonly BrowserCookie[];
}

export type CookieExtractor = (options: GetCookiesOptions) => Promise<GetCookiesResult>;

export interface BrowserCookieOptions {
  readonly fileExists?: (path: string) => boolean;
  readonly getCookies?: CookieExtractor;
  readonly homeDir?: string;
  readonly onWarning?: (warning: string) => void;
  readonly platform?: NodeJS.Platform;
}

const COOKIE_NAMES = ["username", "refresh_token"] as const;

export async function browserCookieCandidates(
  baseUrl: string,
  options: BrowserCookieOptions = {},
): Promise<BrowserCookieCandidate[]> {
  const requestUrl = new URL("/api/auth/access-token", baseUrl).href;
  const platform = options.platform ?? process.platform;
  const browsers = platform === "darwin"
    ? ["chrome", "edge", "firefox", "safari"] as const
    : ["chrome", "edge", "firefox"] as const;
  const getCookies = options.getCookies ?? extractCookies;
  const results: GetCookiesResult[] = [];
  const warnings = new Set<string>();
  for (const browser of browsers) {
    try {
      const result = await getCookies(cookieRequest(requestUrl, browser, platform, options));
      results.push(result);
      for (const warning of result.warnings) warnings.add(normalizeWarning(browser, warning, platform));
    } catch (error) {
      warnings.add(extractorFailure(browser, error, platform));
    }
  }
  for (const warning of warnings) options.onWarning?.(warning);

  const groups = new Map<string, { readonly source: string; readonly cookies: BrowserCookie[] }>();
  for (const cookie of results.flatMap((result) => result.cookies)) {
    if (!COOKIE_NAMES.includes(cookie.name as (typeof COOKIE_NAMES)[number])) continue;
    const browser = cookie.source?.browser ?? "browser";
    const profile = cookie.source?.profile ?? "default";
    const source = [browser, profile, cookie.source?.storeId ?? cookie.source?.origin].filter(Boolean).join(":");
    const sourceKey = JSON.stringify([browser, profile, cookie.source?.storeId, cookie.source?.origin]);
    const mapped = mapCookie(cookie);
    if (!mapped) continue;
    const group = groups.get(sourceKey) ?? { source, cookies: [] };
    group.cookies.push(mapped);
    groups.set(sourceKey, group);
  }

  return [...groups.values()].flatMap(({ source, cookies }): BrowserCookieCandidate[] => {
    const pair = COOKIE_NAMES.map((name) => cookies.find((cookie) => cookie.name === name));
    if (pair.some((cookie) => !cookie)) return [];
    return [{ source, cookies: pair as BrowserCookie[] }];
  });
}

function cookieRequest(
  url: string,
  browser: BrowserName,
  platform: NodeJS.Platform,
  options: BrowserCookieOptions,
): GetCookiesOptions {
  const profile = platform === "darwin" && (browser === "chrome" || browser === "edge")
    ? macosChromiumProfiles(browser, options)
    : ALL_PROFILES;
  return {
    url,
    names: [...COOKIE_NAMES],
    browsers: [browser],
    chromeProfile: browser === "chrome" ? profile : ALL_PROFILES,
    edgeProfile: browser === "edge" ? profile : ALL_PROFILES,
    firefoxProfile: ALL_PROFILES,
    mode: "merge",
  };
}

function macosChromiumProfiles(
  browser: "chrome" | "edge",
  options: BrowserCookieOptions,
): ProfileType {
  const home = options.homeDir ?? homedir();
  const fileExists = options.fileExists ?? existsSync;
  const macPath = posix.join;
  const roots = browser === "chrome"
    ? [
      macPath(home, "Library/Application Support/Google/Chrome"),
      macPath(home, "Library/Application Support/BraveSoftware/Brave-Browser"),
    ]
    : [macPath(home, "Library/Application Support/Microsoft Edge")];
  const names = ["Default", "Guest Profile", ...Array.from({ length: 50 }, (_, index) => `Profile ${index + 1}`)];
  const found = names.filter((name) => roots.some((root) => [
    macPath(root, name, "Cookies"),
    macPath(root, name, "Network/Cookies"),
  ].some(fileExists)));
  return found.length ? found : ALL_PROFILES;
}

function extractorFailure(browser: BrowserName, error: unknown, platform: NodeJS.Platform): string {
  const code = typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" ? error.code : undefined;
  if (code === "EPERM" || code === "EACCES") {
    return permissionWarning(browser, code, platform);
  }
  return `Could not read ${browser} cookies${code ? ` (${code})` : ""}.`;
}

function normalizeWarning(browser: BrowserName, warning: string, platform: NodeJS.Platform): string {
  const code = warning.match(/\b(EPERM|EACCES)\b/iu)?.[1]?.toUpperCase();
  return code === "EPERM" || code === "EACCES"
    ? permissionWarning(browser, code, platform)
    : warning;
}

function permissionWarning(browser: BrowserName, code: "EPERM" | "EACCES", platform: NodeJS.Platform): string {
  const label = `${browser[0]?.toUpperCase() ?? ""}${browser.slice(1)}`;
  const action = platform === "darwin"
    ? "In System Settings > Privacy & Security > Full Disk Access, allow the terminal or app that launched ontrack, then retry."
    : "Allow the terminal or app that launched ontrack to access browser data, then retry.";
  return `Permission denied while reading ${label} cookies (${code}). ${action}`;
}

function mapCookie(cookie: Cookie): BrowserCookie | undefined {
  const domain = cookie.domain ?? hostnameFrom(cookie.url);
  if (!domain) return undefined;
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    ...(cookie.path ? { path: cookie.path } : {}),
    ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
    ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
  };
}

function hostnameFrom(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const hostname = new URL(value).hostname;
    return hostname || undefined;
  } catch {
    return undefined;
  }
}
