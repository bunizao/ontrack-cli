import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { CliError } from "./errors.js";

export interface SessionCacheOptions {
  readonly encryptionKey?: () => Promise<Buffer>;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly runCommand?: typeof runCommand;
  readonly signal?: AbortSignal;
}

type KeyBackend = "keychain" | "secret_service" | "windows_dpapi" | "file" | "provided";

interface EncryptedCache {
  readonly version: 2;
  readonly key_backend: KeyBackend;
  readonly encrypted_session: string;
}

export interface SessionCacheRecord {
  readonly value: unknown;
  readonly encrypted: boolean;
  readonly keyBackend: KeyBackend | "legacy";
}

const SERVICE = "ontrack-cli-session";
const KEYCHAIN_SCRIPT = `
ObjC.import("Foundation")
ObjC.import("Security")
const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
const payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)))
const query = $.NSMutableDictionary.alloc.init
query.setObjectForKey("genp", "class")
query.setObjectForKey(payload.service, "svce")
query.setObjectForKey(payload.id, "acct")
if (payload.operation === "read") {
  query.setObjectForKey(true, "r_Data")
  const result = $()
  const status = Number($.SecItemCopyMatching(query, result))
  if (status !== -25300 && status !== 0) throw new Error("Keychain unavailable: " + status)
  if (status === 0) $.NSFileHandle.fileHandleWithStandardOutput.writeData(result)
} else {
  query.setObjectForKey($(payload.value).dataUsingEncoding($.NSUTF8StringEncoding), "v_Data")
  const status = Number($.SecItemAdd(query, null))
  if (status !== 0 && status !== -25299) throw new Error("Keychain unavailable: " + status)
}
`;
const DPAPI_SCRIPT = `
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Security
if ($payload.operation -eq "read") {
  if (-not [IO.File]::Exists($payload.path)) { exit 0 }
  $protected = [Convert]::FromBase64String([IO.File]::ReadAllText($payload.path))
  $plaintext = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  try { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plaintext)) }
  finally { [Array]::Clear($plaintext, 0, $plaintext.Length) }
} else {
  $plaintext = [Text.Encoding]::UTF8.GetBytes($payload.value)
  try {
    $protected = [Security.Cryptography.ProtectedData]::Protect($plaintext, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($payload.path)) | Out-Null
    $stream = [IO.File]::Open($payload.path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($protected))
      $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
  } finally { [Array]::Clear($plaintext, 0, $plaintext.Length) }
}
`;

export class SessionKeyCommandError extends Error {
  constructor(readonly code: number | string | null, readonly detail: string) {
    super("The session key store could not be accessed.");
  }
}

async function runCommand(command: string, args: string[], input = "", signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SessionKeyCommandError("TIMEOUT", ""));
    }, 5_000);
    const onAbort = () => {
      child.kill("SIGKILL");
      reject(new CliError("cancellation", "Authentication cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.on("error", () => undefined);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new SessionKeyCommandError(error.code ?? null, ""));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolveResult(stdout.trim());
      else reject(new SessionKeyCommandError(code, stderr));
    });
    child.stdin.end(input);
  });
}

function cacheError(message: string): CliError {
  return new CliError("auth", message, undefined, "Run `ontrack auth login` to sign in again. The previous cache has been kept.");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return undefined;
    throw cacheError("Could not read the authenticated session cache.");
  }
}

function encryptedCache(value: unknown): EncryptedCache | undefined {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 2) return undefined;
  if (!("key_backend" in value) || !("encrypted_session" in value) || typeof value.encrypted_session !== "string"
    || !["keychain", "secret_service", "windows_dpapi", "file", "provided"].includes(String(value.key_backend))) {
    throw cacheError("The encrypted session cache is invalid.");
  }
  return value as EncryptedCache;
}

async function keyValue(backend: KeyBackend, id: string, options: SessionCacheOptions, create: boolean): Promise<Buffer> {
  if (options.encryptionKey) {
    const key = await options.encryptionKey();
    if (key.length !== 32) throw cacheError("The session encryption key is invalid.");
    return key;
  }
  const runner = options.runCommand ?? runCommand;
  const run = (command: string, args: string[], input?: string) => runner(command, args, input, options.signal);
  const keyPath = join(options.homeDir ?? homedir(), ".config", "ontrack-cli", "keys", `${id}.key`);
  const read = async (): Promise<string> => {
    if (backend === "keychain") return run("osascript", ["-l", "JavaScript", "-e", KEYCHAIN_SCRIPT], JSON.stringify({ operation: "read", service: SERVICE, id }));
    if (backend === "secret_service") {
      try { return await run("secret-tool", ["lookup", "service", SERVICE, "profile", id]); }
      catch (error) { if (error instanceof SessionKeyCommandError && error.code === 1 && !error.detail.trim()) return ""; throw error; }
    }
    if (backend === "windows_dpapi") return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT], JSON.stringify({ operation: "read", path: keyPath }));
    if (backend === "file") {
      try { return (await readFile(keyPath, "utf8")).trim(); }
      catch (error) { if (isMissing(error)) return ""; throw error; }
    }
    throw cacheError("The session encryption key is unavailable.");
  };
  let value = await read();
  if (!value && create) {
    const generated = randomBytes(32).toString("base64");
    if (backend === "keychain") await run("osascript", ["-l", "JavaScript", "-e", KEYCHAIN_SCRIPT], JSON.stringify({ operation: "write", service: SERVICE, id, value: generated }));
    else if (backend === "secret_service") await run("secret-tool", ["store", "--label", "OnTrack session encryption", "service", SERVICE, "profile", id], generated);
    else if (backend === "windows_dpapi") {
      // A concurrent process may have created the key first. Read that winner.
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT], JSON.stringify({ operation: "write", path: keyPath, value: generated })).catch(async (error: unknown) => {
        if (!await read()) throw error;
      });
    } else if (backend === "file") {
      await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(keyPath), 0o700);
      try { await writeFile(keyPath, generated, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
      catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
    }
    value = await read();
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw cacheError("The session encryption key is missing or invalid.");
  return key;
}

function keyId(sessionFile: string): string {
  return createHash("sha256").update(resolve(sessionFile)).digest("hex").slice(0, 24);
}

async function withKeyLock<T>(id: string, options: SessionCacheOptions, action: () => Promise<T>): Promise<T> {
  if (options.encryptionKey) return action();
  const directory = join(options.homeDir ?? homedir(), ".config", "ontrack-cli", "keys");
  const lock = join(directory, `${id}.lock`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (options.signal?.aborted) throw new CliError("cancellation", "Authentication cancelled.");
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
      const age = await stat(lock).then((value) => Date.now() - value.mtimeMs, () => 0);
      if (age > 60_000) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw cacheError("Timed out waiting for the session encryption key store.");
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

async function cacheKey(sessionFile: string, options: SessionCacheOptions, backend?: KeyBackend): Promise<{ key: Buffer; backend: KeyBackend }> {
  const selected = backend ?? (options.encryptionKey ? "provided" : (options.platform ?? process.platform) === "darwin" ? "keychain"
    : (options.platform ?? process.platform) === "win32" ? "windows_dpapi" : "secret_service");
  try {
    const read = () => keyValue(selected, keyId(sessionFile), options, backend === undefined);
    return { key: backend === undefined ? await withKeyLock(keyId(sessionFile), options, read) : await read(), backend: selected };
  } catch (error) {
    const unavailable = error instanceof SessionKeyCommandError && (error.code === "ENOENT"
      || (selected === "secret_service" && /D-Bus|DBus|Cannot autolaunch|not available|cannot connect|connection refused/i.test(error.detail)));
    if (!backend && selected === "secret_service" && unavailable) return { key: await keyValue("file", keyId(sessionFile), options, true), backend: "file" };
    if (error instanceof CliError) throw error;
    throw cacheError("Could not access the session encryption key store.");
  }
}

export async function readSessionCache(sessionFile: string, options: SessionCacheOptions = {}): Promise<SessionCacheRecord | undefined> {
  const value = await readJson(sessionFile);
  if (value === undefined) return undefined;
  const encrypted = encryptedCache(value);
  if (!encrypted) return { value, encrypted: false, keyBackend: "legacy" };
  try {
    const { key } = await cacheKey(sessionFile, options, encrypted.key_backend);
    const bytes = Buffer.from(encrypted.encrypted_session, "base64");
    if (bytes.length < 28) throw new Error("Invalid ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`ontrack-session:${keyId(sessionFile)}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    return { value: JSON.parse(plaintext) as unknown, encrypted: true, keyBackend: encrypted.key_backend };
  } catch (error) {
    if (error instanceof CliError && error.category === "cancellation") throw error;
    throw cacheError("Could not decrypt the authenticated session cache.");
  }
}

export async function writeSessionCache(sessionFile: string, value: unknown, options: SessionCacheOptions = {}): Promise<void> {
  let previous: unknown;
  try { previous = await readJson(sessionFile); }
  catch { throw cacheError("Could not write the authenticated session cache."); }
  let existing: EncryptedCache | undefined;
  try { existing = encryptedCache(previous); }
  catch { existing = undefined; }
  let material: { key: Buffer; backend: KeyBackend };
  try {
    material = await cacheKey(sessionFile, options, existing?.key_backend);
  } catch (error) {
    // A fresh sign-in may replace a cache whose key has been lost; never delete it first.
    if (!existing || (error instanceof CliError && error.category === "cancellation")) throw error;
    material = await cacheKey(sessionFile, options);
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", material.key, nonce);
  cipher.setAAD(Buffer.from(`ontrack-session:${keyId(sessionFile)}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const stored: EncryptedCache = { version: 2, key_backend: material.backend, encrypted_session: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64") };
  const temporary = `${sessionFile}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(sessionFile), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, sessionFile);
  } catch {
    throw cacheError("Could not write the authenticated session cache.");
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
