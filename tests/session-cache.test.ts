import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../src/errors.js";
import { readSessionCache, SessionKeyCommandError, writeSessionCache } from "../src/session-cache.js";

const options = { encryptionKey: async () => Buffer.alloc(32, 9) };

export async function test_session_cache_encrypts_and_authenticates_credentials(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-cache-test-"));
  const file = join(directory, "session.json");
  try {
    const value = { access_token: "test-access", refresh_cookie: "test-refresh", username: "test-user" };
    await writeSessionCache(file, value, options);
    const raw = await readFile(file, "utf8");
    assert.doesNotMatch(raw, /test-access|test-refresh|test-user/);
    assert.deepEqual((await readSessionCache(file, options))?.value, value);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    const tampered = JSON.parse(raw) as { encrypted_session: string };
    const bytes = Buffer.from(tampered.encrypted_session, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    tampered.encrypted_session = bytes.toString("base64");
    await writeFile(file, JSON.stringify(tampered));
    await assert.rejects(readSessionCache(file, options), (error) => error instanceof CliError && /decrypt/u.test(error.message));
    assert.equal(await readFile(file, "utf8"), JSON.stringify(tampered));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function test_session_cache_does_not_delete_data_when_the_key_is_wrong(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-cache-key-"));
  const file = join(directory, "session.json");
  try {
    await writeSessionCache(file, { access_token: "test-access" }, options);
    const before = await readFile(file, "utf8");
    await assert.rejects(readSessionCache(file, { encryptionKey: async () => Buffer.alloc(32, 10) }), CliError);
    assert.equal(await readFile(file, "utf8"), before);
    await assert.rejects(readSessionCache(file, { encryptionKey: async () => Buffer.alloc(1) }), CliError);
    assert.equal(await readFile(file, "utf8"), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function test_session_cache_uses_a_private_key_file_when_secret_service_is_absent(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-cache-file-"));
  const file = join(directory, "session.json");
  const local = { platform: "linux" as const, homeDir: directory, runCommand: async () => { throw new SessionKeyCommandError("ENOENT", ""); } };
  try {
    await writeSessionCache(file, { access_token: "test-access" }, local);
    const record = await readSessionCache(file, local);
    assert.equal(record?.keyBackend, "file");
    assert.deepEqual(record?.value, { access_token: "test-access" });
    assert.doesNotMatch(await readFile(file, "utf8"), /test-access/);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function test_session_cache_keeps_legacy_data_if_keychain_access_is_denied(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-cache-denied-"));
  const file = join(directory, "session.json");
  const legacy = '{"access_token":"test-access"}';
  try {
    await writeFile(file, legacy);
    await assert.rejects(writeSessionCache(file, { access_token: "replacement" }, {
      platform: "darwin", homeDir: directory,
      runCommand: async () => { throw new SessionKeyCommandError(1, "Keychain access denied"); },
    }), CliError);
    assert.equal(await readFile(file, "utf8"), legacy);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
