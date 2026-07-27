import {
  ALL_PROFILES,
  getCookies as extractCookies,
  type Cookie,
  type BrowserName,
  type GetCookiesOptions,
  type GetCookiesResult,
} from "@steipete/sweet-cookie";

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
  readonly getCookies?: CookieExtractor;
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
      const result = await getCookies(cookieRequest(requestUrl, browser));
      results.push(result);
      for (const warning of result.warnings) warnings.add(warning);
    } catch {
      warnings.add(`Could not read ${browser} cookies.`);
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

function cookieRequest(url: string, browser: BrowserName): GetCookiesOptions {
  return {
    url,
    names: [...COOKIE_NAMES],
    browsers: [browser],
    chromeProfile: ALL_PROFILES,
    edgeProfile: ALL_PROFILES,
    firefoxProfile: ALL_PROFILES,
    mode: "merge",
  };
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
