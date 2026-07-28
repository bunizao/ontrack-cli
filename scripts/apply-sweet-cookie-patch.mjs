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

let patchedSqliteSource = sqliteSource;
if (!patchedSqliteSource.includes(sqliteReplacement)) {
  if (!patchedSqliteSource.includes(sqliteOriginal)) {
    throw new Error("Unsupported @steipete/sweet-cookie SQLite source; update the compatibility patch.");
  }
  patchedSqliteSource = patchedSqliteSource.replace(sqliteOriginal, sqliteReplacement);
}

const directReadMarkers = [
  'import { pathToFileURL } from "node:url";',
  "const directResult = await readChromeDatabase(options.dbPath, where);",
  "function readOnlyDatabasePaths(dbPath)",
  "async function readChromeDatabase(dbPath, where)",
];
const installedDirectReadMarkers = directReadMarkers.filter((marker) => patchedSqliteSource.includes(marker));
if (installedDirectReadMarkers.length > 0 && installedDirectReadMarkers.length < directReadMarkers.length) {
  throw new Error("Incomplete @steipete/sweet-cookie direct-read patch; reinstall the dependency and rebuild.");
}
if (installedDirectReadMarkers.length === 0) {
  const functionStart = patchedSqliteSource.indexOf("export async function getCookiesFromChromeSqliteDb(");
  const functionEnd = patchedSqliteSource.indexOf("\nfunction collectChromeCookiesFromRows", functionStart);
  const helperInsertion = patchedSqliteSource.indexOf("async function readChromiumMetaVersion(dbPath)");
  if (functionStart < 0 || functionEnd < 0 || helperInsertion < 0) {
    throw new Error("Unsupported @steipete/sweet-cookie Chrome database source; update the direct-read patch.");
  }
  const directReadFunction = `export async function getCookiesFromChromeSqliteDb(options, origins, allowlistNames, decrypt) {
    const warnings = [];
    const hosts = origins.map((o) => new URL(o).hostname);
    const where = buildHostWhereClause(hosts, "host_key");
    const collectOptions = {};
    if (options.profile) {
        collectOptions.profile = options.profile;
    }
    if (options.storeId) {
        collectOptions.storeId = options.storeId;
    }
    if (options.includeExpired !== undefined) {
        collectOptions.includeExpired = options.includeExpired;
    }
    const directResult = await readChromeDatabase(options.dbPath, where);
    if (directResult.ok) {
        const cookies = collectChromeCookiesFromRows(directResult.rows, collectOptions, hosts, allowlistNames, (encryptedValue) => decrypt(encryptedValue, { stripHashPrefix: directResult.metaVersion >= 24 }), warnings);
        return { cookies: dedupeCookies(cookies), warnings };
    }
    // Chrome can keep its cookie DB locked and/or rely on WAL sidecars. Fall back to a
    // stable snapshot only when SQLite cannot read the original database directly.
    let tempDir;
    try {
        tempDir = mkdtempSync(path.join(tmpdir(), "sweet-cookie-chrome-"));
        const tempDbPath = path.join(tempDir, "Cookies");
        copyFileSync(options.dbPath, tempDbPath);
        copySidecar(options.dbPath, \`\${tempDbPath}-wal\`, "-wal");
        copySidecar(options.dbPath, \`\${tempDbPath}-shm\`, "-shm");
        const snapshotResult = await readChromeDatabase(tempDbPath, where);
        if (!snapshotResult.ok) {
            warnings.push(snapshotResult.error);
            return { cookies: [], warnings };
        }
        const cookies = collectChromeCookiesFromRows(snapshotResult.rows, collectOptions, hosts, allowlistNames, (encryptedValue) => decrypt(encryptedValue, { stripHashPrefix: snapshotResult.metaVersion >= 24 }), warnings);
        return { cookies: dedupeCookies(cookies), warnings };
    }
    catch (error) {
        warnings.push(\`Failed to copy Chrome cookie DB: \${error instanceof Error ? error.message : String(error)}\`);
        return { cookies: [], warnings };
    }
    finally {
        if (tempDir) {
            rmSync(tempDir, { recursive: true, force: true });
        }
    }
}`;
  patchedSqliteSource = `${patchedSqliteSource.slice(0, functionStart)}${directReadFunction}${patchedSqliteSource.slice(functionEnd)}`;

  const updatedHelperInsertion = patchedSqliteSource.indexOf("async function readChromiumMetaVersion(dbPath)");
  const directReadHelpers = `function readOnlyDatabasePaths(dbPath) {
    if (!isBunRuntime()) {
        // node:sqlite does not accept SQLite URI filenames; readOnly is its mode=ro equivalent.
        return [dbPath];
    }
    const uri = pathToFileURL(dbPath).href;
    return [\`\${uri}?mode=ro\`, \`\${uri}?mode=ro&nolock=1\`, \`\${uri}?mode=ro&immutable=1\`];
}
async function readChromeDatabase(dbPath, where) {
    let lastError = "Unable to read Chrome cookie database.";
    for (const readPath of readOnlyDatabasePaths(dbPath)) {
        const metaVersion = await readChromiumMetaVersion(readPath);
        const rowsResult = await readChromeRows(readPath, where);
        if (rowsResult.ok) {
            return { ok: true, rows: rowsResult.rows, metaVersion };
        }
        lastError = rowsResult.error;
    }
    return { ok: false, error: lastError };
}
`;
  patchedSqliteSource = `${patchedSqliteSource.slice(0, updatedHelperInsertion)}${directReadHelpers}${patchedSqliteSource.slice(updatedHelperInsertion)}`;
  patchedSqliteSource = patchedSqliteSource.replace(
    'import path from "node:path";',
    'import path from "node:path";\nimport { pathToFileURL } from "node:url";',
  );
}

if (
  !directReadMarkers.every((marker) => patchedSqliteSource.includes(marker))
  || patchedSqliteSource.indexOf(directReadMarkers[1]) > patchedSqliteSource.indexOf("mkdtempSync(")
) {
  throw new Error("Failed to install the @steipete/sweet-cookie direct-read patch.");
}

if (patchedSqliteSource !== sqliteSource) {
  writeFileSync(sqliteTarget, patchedSqliteSource, "utf8");
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
