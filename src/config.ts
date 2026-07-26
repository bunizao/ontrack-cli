import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";

import { CliError } from "./errors.js";
import type { UserView } from "./types.js";
import { safeUserView } from "./user.js";

export type Environment = Readonly<Record<string, string | undefined>>;

export interface ConfigPaths {
  readonly configDir: string;
  readonly configFile: string;
  readonly sessionFile: string;
}

export interface ConfigPathOptions {
  readonly env: Environment;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly cwd: string;
  readonly cwdConfigExists?: boolean;
}

export interface OnTrackConfig {
  readonly base_url?: unknown;
  readonly username?: unknown;
  readonly auth_token?: unknown;
  readonly doubtfire_user?: unknown;
  readonly doubtfire_user_json?: unknown;
  readonly [key: string]: unknown;
}

export interface CredentialSource {
  readonly username: string;
  readonly accessToken: string;
  readonly provenance: "environment" | "config" | "migration";
  readonly user: UserView | null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveConfigPaths(options: ConfigPathOptions): ConfigPaths {
  const path = options.platform === "win32" ? win32 : posix;
  const explicit = nonEmptyString(options.env.ONTRACK_CONFIG);
  let configFile: string;
  if (explicit) {
    configFile = path.isAbsolute(explicit) ? path.normalize(explicit) : path.resolve(options.cwd, explicit);
  } else if (options.cwdConfigExists) {
    configFile = path.join(options.cwd, "config.yaml");
  } else if (options.platform === "win32") {
    const root = nonEmptyString(options.env.APPDATA) ?? path.join(options.homeDir, "AppData", "Roaming");
    configFile = path.join(root, "ontrack-cli", "config.yaml");
  } else {
    const root = nonEmptyString(options.env.XDG_CONFIG_HOME) ?? path.join(options.homeDir, ".config");
    configFile = path.join(root, "ontrack-cli", "config.yaml");
  }
  const configDir = dirnameForPlatform(configFile, options.platform);
  return { configDir, configFile, sessionFile: path.join(configDir, "session.json") };
}

function dirnameForPlatform(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? win32.dirname(value) : posix.dirname(value);
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const body = trimmed.slice(1, -1);
    return trimmed.startsWith('"') ? JSON.parse(trimmed) : body.replaceAll("''", "'");
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Treat non-JSON flow-style text as a plain scalar.
    }
  }
  return trimmed.replace(/\s+#.*$/, "");
}

function parseConfigText(text: string, configFile: string): OnTrackConfig {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as OnTrackConfig;
    } catch (error) {
      throw new CliError("config", `Config file ${configFile} contains invalid JSON.`);
    }
    throw new CliError("config", `Config file ${configFile} must contain an object.`);
  }

  const config: Record<string, unknown> = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const content = line.trim();
    if (!content || content.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*):(?:\s*(.*))?$/.exec(content);
    if (!match?.[1]) {
      throw new CliError("config", `Config file ${configFile} has invalid YAML at line ${index + 1}.`);
    }
    try {
      config[match[1]] = parseScalar(match[2] ?? "");
    } catch {
      throw new CliError("config", `Config file ${configFile} has an invalid value at line ${index + 1}.`);
    }
  }
  return config;
}

export function loadConfig(paths: ConfigPaths): OnTrackConfig {
  if (!existsSync(paths.configFile)) return {};
  try {
    return parseConfigText(readFileSync(paths.configFile, "utf8"), paths.configFile);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("config", `Could not read config file ${paths.configFile}.`);
  }
}

export function resolveBaseUrl(env: Environment, config: OnTrackConfig): string {
  const candidate = nonEmptyString(env.ONTRACK_BASE_URL) ?? nonEmptyString(config.base_url);
  if (!candidate) throw new CliError("config", "No base_url configured.");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new CliError("config", "Base URL must be an absolute HTTP or HTTPS URL.");
  }
  if (!(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:")) {
    throw new CliError("config", "Base URL must use HTTP or HTTPS.");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new CliError("config", "Base URL must be the site root.");
  }
  return url.origin;
}

function parseMigration(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") throw new CliError("config", "doubtfire_user data must be an object.");
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    throw new CliError("config", "Invalid ONTRACK_DOUBTFIRE_USER_JSON payload.");
  }
  throw new CliError("config", "doubtfire_user payload must decode to an object.");
}

function credentials(
  username: unknown,
  token: unknown,
  provenance: CredentialSource["provenance"],
  user: UserView | null = null,
): CredentialSource | undefined {
  const resolvedUsername = nonEmptyString(username);
  const accessToken = nonEmptyString(token);
  return resolvedUsername && accessToken ? { username: resolvedUsername, accessToken, provenance, user } : undefined;
}

export function resolveCredentialSource(env: Environment, config: OnTrackConfig): CredentialSource | undefined {
  const environment = credentials(env.ONTRACK_USERNAME, env.ONTRACK_AUTH_TOKEN, "environment");
  if (environment) return environment;
  const configured = credentials(config.username, config.auth_token, "config");
  if (configured) return configured;

  const migration = parseMigration(env.ONTRACK_DOUBTFIRE_USER_JSON ?? config.doubtfire_user_json ?? config.doubtfire_user);
  if (!migration) return undefined;
  return credentials(
    migration.username,
    migration.authenticationToken ?? migration.authentication_token,
    "migration",
    safeUserView(migration),
  );
}
