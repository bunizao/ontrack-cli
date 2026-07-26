import { execFile as execFileCallback } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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

export interface ExecFileResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type ExecFile = (file: string, args: readonly string[]) => Promise<ExecFileResult>;
export type CookieFileReader = (requestUrl: string, cookieFile: string) => Promise<readonly BrowserCookie[]>;

export interface BrowserCookieOptions {
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: Date;
  readonly chromiumCookieReader?: CookieFileReader;
  readonly firefoxCookieReader?: CookieFileReader;
  readonly execFile?: ExecFile;
}

const FIREFOX_QUERY = [
  "SELECT name, value, host AS domain, path, expiry AS expires, isSecure AS secure",
  "FROM moz_cookies",
  "WHERE name IN ('username', 'refresh_token')",
  "ORDER BY length(path) DESC, creationTime ASC;",
].join(" ");

const CHROMIUM_QUERY = [
  "SELECT name, value, host_key AS domain, path, is_secure AS secure,",
  "CASE WHEN has_expires = 1 THEN (expires_utc / 1000000) - 11644473600 ELSE 0 END AS expires,",
  "hex(encrypted_value) AS encrypted_value",
  "FROM cookies",
  "WHERE name IN ('username', 'refresh_token')",
  "ORDER BY length(path) DESC, creation_utc ASC;",
].join(" ");

const COOKIE_NAMES = ["username", "refresh_token"] as const;

export async function browserCookieCandidates(
  baseUrl: string,
  options: BrowserCookieOptions = {},
): Promise<BrowserCookieCandidate[]> {
  const requestUrl = new URL("/api/auth/access-token", baseUrl).href;
  const now = options.now ?? new Date();
  const execFile = options.execFile ?? defaultExecFile;
  const platform = options.platform ?? process.platform;
  const firefoxReader = options.firefoxCookieReader ?? firefoxReaderWith(execFile);
  const candidates: BrowserCookieCandidate[] = [];

  for (const browser of ["Chrome", "Brave", "Edge"] as const) {
    const chromiumReader = options.chromiumCookieReader ?? chromiumReaderWith(browser, platform, execFile);
    for (const profile of await chromiumProfiles(browser, options)) {
      for (const cookieFile of profile.cookieFiles) {
        const cookies = await safelyRead(chromiumReader, requestUrl, cookieFile);
        const pair = applicableCredentialPair(cookies, requestUrl, now);
        if (!pair) continue;
        candidates.push({ source: `${browser}:${profile.name}`, cookies: pair });
        break;
      }
    }
  }

  for (const cookieFile of await firefoxCookieFiles(options)) {
    const cookies = await safelyRead(firefoxReader, requestUrl, cookieFile);
    const pair = applicableCredentialPair(cookies, requestUrl, now);
    if (pair) candidates.push({ source: `Firefox:${basename(dirname(cookieFile))}`, cookies: pair });
  }

  return candidates;
}

async function safelyRead(
  reader: CookieFileReader,
  requestUrl: string,
  cookieFile: string,
): Promise<readonly BrowserCookie[]> {
  try {
    return await reader(requestUrl, cookieFile);
  } catch {
    return [];
  }
}

function applicableCredentialPair(
  cookies: readonly BrowserCookie[],
  requestUrl: string,
  now: Date,
): readonly BrowserCookie[] | undefined {
  const selected = new Map<string, BrowserCookie>();
  for (const cookie of cookies) {
    if (!COOKIE_NAMES.includes(cookie.name as (typeof COOKIE_NAMES)[number])) continue;
    if (selected.has(cookie.name) || !cookieApplies(cookie, requestUrl, now)) continue;
    selected.set(cookie.name, cookie);
  }
  if (!COOKIE_NAMES.every((name) => selected.has(name))) return undefined;
  return COOKIE_NAMES.map((name) => selected.get(name)!);
}

function cookieApplies(cookie: BrowserCookie, requestUrl: string, now: Date): boolean {
  if (!cookie.value || /[;\r\n]/u.test(cookie.name) || /[;\r\n]/u.test(cookie.value)) return false;
  const url = new URL(requestUrl);
  if (!cookie.domain || !domainMatches(url.hostname, cookie.domain)) return false;
  const path = cookie.path?.startsWith("/") ? cookie.path : "/";
  if (!pathMatches(url.pathname, path)) return false;
  if (cookie.secure === true && url.protocol !== "https:") return false;
  return !isExpired(cookie.expires, now);
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./u, "");
  const host = hostname.toLowerCase();
  return Boolean(normalized) && (host === normalized || host.endsWith(`.${normalized}`));
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (!requestPath.startsWith(cookiePath)) return false;
  return requestPath.length === cookiePath.length || cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function isExpired(value: BrowserCookie["expires"], now: Date): boolean {
  if (value === undefined || value === "" || value === 0) return false;
  const expiry = typeof value === "number" ? new Date(value * 1_000) : new Date(value);
  return Number.isNaN(expiry.valueOf()) || expiry.valueOf() <= now.valueOf();
}

function chromiumReaderWith(
  browser: "Chrome" | "Brave" | "Edge",
  platform: NodeJS.Platform,
  execFile: ExecFile,
): CookieFileReader {
  if (platform !== "darwin") return async () => [];
  let key: Promise<Buffer | null> | undefined;
  return async (_requestUrl, cookieFile) => {
    const result = await execFile("sqlite3", ["-readonly", "-json", cookieFile, CHROMIUM_QUERY]);
    if (result.exitCode !== 0 || !result.stdout.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const rows = parsed.filter(isRecord);
    if (rows.some((row) => !nonEmptyString(row.value) && nonEmptyString(row.encrypted_value))) {
      key ??= loadChromiumKey(browser, execFile);
    }
    const resolvedKey = key ? await key : null;
    return rows.flatMap((row): BrowserCookie[] => {
      if (typeof row.name !== "string" || typeof row.domain !== "string") return [];
      const value = nonEmptyString(row.value) ?? decryptChromiumValue(row.encrypted_value, row.domain, resolvedKey);
      if (!value) return [];
      return [{
        name: row.name,
        value,
        domain: row.domain,
        ...(typeof row.path === "string" ? { path: row.path } : {}),
        ...(row.secure === 1 || row.secure === true ? { secure: true } : {}),
        ...(typeof row.expires === "number" || typeof row.expires === "string" ? { expires: row.expires } : {}),
      }];
    });
  };
}

async function loadChromiumKey(
  browser: "Chrome" | "Brave" | "Edge",
  execFile: ExecFile,
): Promise<Buffer | null> {
  const service = browser === "Edge" ? "Microsoft Edge Safe Storage" : `${browser} Safe Storage`;
  const result = await execFile("security", ["find-generic-password", "-w", "-s", service]);
  if (result.exitCode !== 0) return null;
  const password = result.stdout.replace(/\r?\n$/u, "");
  if (!password) return null;
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

function decryptChromiumValue(encrypted: unknown, domain: string, key: Buffer | null): string | undefined {
  if (!key || typeof encrypted !== "string" || !/^[0-9a-f]+$/iu.test(encrypted) || encrypted.length % 2 !== 0) return undefined;
  const payload = Buffer.from(encrypted, "hex");
  if (payload.length <= 3 || (payload.subarray(0, 3).toString("ascii") !== "v10" && payload.subarray(0, 3).toString("ascii") !== "v11")) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plaintext = Buffer.concat([decipher.update(payload.subarray(3)), decipher.final()]);
    const domainHash = createHash("sha256").update(domain).digest();
    const value = plaintext.subarray(0, domainHash.length).equals(domainHash)
      ? plaintext.subarray(domainHash.length)
      : plaintext;
    return value.toString("utf8") || undefined;
  } catch {
    return undefined;
  }
}

function firefoxReaderWith(execFile: ExecFile): CookieFileReader {
  return async (_requestUrl, cookieFile) => {
    const result = await execFile("sqlite3", ["-readonly", "-json", cookieFile, FIREFOX_QUERY]);
    if (result.exitCode !== 0 || !result.stdout.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row): BrowserCookie[] => {
      if (!isRecord(row) || typeof row.name !== "string" || typeof row.value !== "string") return [];
      return [{
        name: row.name,
        value: row.value,
        ...(typeof row.domain === "string" ? { domain: row.domain } : {}),
        ...(typeof row.path === "string" ? { path: row.path } : {}),
        ...(row.secure === 1 || row.secure === true ? { secure: true } : {}),
        ...(typeof row.expires === "number" || typeof row.expires === "string" ? { expires: row.expires } : {}),
      }];
    });
  };
}

interface ChromiumProfile {
  readonly name: string;
  readonly cookieFiles: readonly string[];
}

async function chromiumProfiles(
  browser: "Chrome" | "Brave" | "Edge",
  options: BrowserCookieOptions,
): Promise<ChromiumProfile[]> {
  const profiles: ChromiumProfile[] = [];
  for (const root of chromiumUserDataDirs(browser, options)) {
    for (const name of await profileDirectories(root, false)) {
      const cookieFiles: string[] = [];
      for (const relative of ["Network/Cookies", "Cookies"] as const) {
        const file = join(root, name, relative);
        if (await isFile(file)) cookieFiles.push(file);
      }
      if (cookieFiles.length) profiles.push({ name, cookieFiles });
    }
  }
  return profiles;
}

function chromiumUserDataDirs(
  browser: "Chrome" | "Brave" | "Edge",
  options: BrowserCookieOptions,
): string[] {
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const directories = {
    darwin: {
      Chrome: ["Library/Application Support/Google/Chrome"],
      Brave: ["Library/Application Support/BraveSoftware/Brave-Browser"],
      Edge: ["Library/Application Support/Microsoft Edge"],
    },
    linux: {
      Chrome: [".config/google-chrome", ".var/app/com.google.Chrome/config/google-chrome"],
      Brave: [".config/BraveSoftware/Brave-Browser", ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"],
      Edge: [".config/microsoft-edge"],
    },
    win32: {
      Chrome: ["AppData/Local/Google/Chrome/User Data"],
      Brave: ["AppData/Local/BraveSoftware/Brave-Browser/User Data"],
      Edge: ["AppData/Local/Microsoft/Edge/User Data"],
    },
  } as const;
  return [...(directories[platform as keyof typeof directories]?.[browser] ?? [])].map((part) => join(home, part));
}

async function firefoxCookieFiles(options: BrowserCookieOptions): Promise<string[]> {
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const roots = {
    darwin: ["Library/Application Support/Firefox/Profiles"],
    linux: [".mozilla/firefox"],
    win32: ["AppData/Roaming/Mozilla/Firefox/Profiles"],
  } as const;
  const files: string[] = [];
  for (const rootPart of roots[platform as keyof typeof roots] ?? []) {
    const root = join(home, rootPart);
    for (const profile of await profileDirectories(root, true)) {
      const file = join(root, profile, "cookies.sqlite");
      if (await isFile(file)) files.push(file);
    }
  }
  return files;
}

async function profileDirectories(root: string, allowAnyDirectory: boolean): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => allowAnyDirectory || name === "Default" || name === "Guest Profile" || name.startsWith("Profile "))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function defaultExecFile(file: string, args: readonly string[]): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFileCallback(file, [...args], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        reject(error);
        return;
      }
      const exitCode = error
        ? typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : 1
        : 0;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
