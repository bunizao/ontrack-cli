import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function test_macos_keychain_access_matches_browser_cookie3_authorization_command(): void {
  const source = readFileSync(
    "node_modules/@steipete/sweet-cookie/dist/providers/chromium/macosKeychain.js",
    "utf8",
  );

  assert.match(source, /execCapture\("\/usr\/bin\/security", \["-q", "find-generic-password"/u);
  assert.doesNotMatch(source, /execCapture\("security", \["find-generic-password"/u);
}

export function test_chromium_expiry_larger_than_number_is_read_on_supported_node_versions(): void {
  const directory = mkdtempSync(join(tmpdir(), "ontrack-cookie-compat-"));
  const database = join(directory, "Cookies");
  const script = `
    import { DatabaseSync } from "node:sqlite";
    import { resolve } from "node:path";
    import { pathToFileURL } from "node:url";
    const database = process.argv[1];
    const db = new DatabaseSync(database);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, path TEXT, expires_utc INTEGER, samesite INTEGER, encrypted_value BLOB, is_secure INTEGER, is_httponly INTEGER);");
    db.prepare("INSERT INTO meta VALUES (?, ?)").run("version", "24");
    db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("refresh_token", "fixture", ".example.edu", "/api/auth", 13464187827932941n, 1, new Uint8Array(), 1, 1);
    db.close();
    const shared = resolve("node_modules/@steipete/sweet-cookie/dist/providers/chromeSqlite/shared.js");
    const { getCookiesFromChromeSqliteDb } = await import(pathToFileURL(shared));
    const result = await getCookiesFromChromeSqliteDb({ dbPath: database }, ["https://ontrack.example.edu"], new Set(["refresh_token"]), () => null);
    if (result.warnings.length || result.cookies.length !== 1) process.exit(1);
  `;
  const executable = Reflect.get(process.versions, "bun") ? "node" : process.execPath;
  try {
    const result = spawnSync(executable, [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "--eval",
      script,
      database,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
