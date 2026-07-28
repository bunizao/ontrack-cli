import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageEntry = fileURLToPath(import.meta.resolve("@steipete/sweet-cookie"));
const providersDirectory = join(dirname(packageEntry), "providers");

const sqliteTarget = join(providersDirectory, "chromeSqlite/shared.js");
const sqliteOriginal = "const rows = db.prepare(options.sql).all();";
const sqliteReplacement = `const statement = db.prepare(options.sql);
            if (typeof statement.setReadBigInts === "function") {
                statement.setReadBigInts(true);
            }
            const rows = statement.all();`;
const sqliteSource = readFileSync(sqliteTarget, "utf8");

if (!sqliteSource.includes(sqliteReplacement)) {
  if (!sqliteSource.includes(sqliteOriginal)) {
    throw new Error("Unsupported @steipete/sweet-cookie SQLite source; update the compatibility patch.");
  }
  writeFileSync(sqliteTarget, sqliteSource.replace(sqliteOriginal, sqliteReplacement), "utf8");
}

const keychainTarget = join(providersDirectory, "chromium/macosKeychain.js");
const keychainOriginal = "execCapture(\"security\", [\"find-generic-password\"";
const keychainReplacement = "execCapture(\"/usr/bin/security\", [\"-q\", \"find-generic-password\"";
const keychainSource = readFileSync(keychainTarget, "utf8");

if (!keychainSource.includes(keychainReplacement)) {
  if (!keychainSource.includes(keychainOriginal)) {
    throw new Error("Unsupported @steipete/sweet-cookie Keychain source; update the compatibility patch.");
  }
  writeFileSync(keychainTarget, keychainSource.replace(keychainOriginal, keychainReplacement), "utf8");
}
