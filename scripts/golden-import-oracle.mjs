import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const oracleCommit = "06e0c4b6d45cdda4e999e4c829d61bfe8392ef8c";
const [capturePath, sourceId, recordedAt, confirmation] = process.argv.slice(2);

if (!capturePath || !sourceId || !recordedAt || confirmation !== "--confirm-live-recorded") {
  process.stderr.write("Usage: node scripts/golden-import-oracle.mjs <capture.jsonl> <source-id> <recorded-at-iso> --confirm-live-recorded\n");
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]*$/u.test(sourceId)) throw new Error("source-id must contain lowercase letters, numbers, and hyphens only");
if (Number.isNaN(new Date(recordedAt).valueOf())) throw new Error("recorded-at-iso must be a valid timestamp");

const capture = await readFile(capturePath, "utf8");
const records = capture.split(/\r?\n/u).filter(Boolean).map((line, index) => {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`capture line ${index + 1} is not JSON`);
  }
});
if (records.length === 0) throw new Error("capture contains no records");

const allowedPath = /^\/api\/(?:auth\/method|projects(?:\/\d+)?|units\/\d+)$/u;
for (const [index, record] of records.entries()) {
  const request = record?.request;
  const response = record?.response;
  if (request?.method !== "GET" || typeof request.path !== "string" || !allowedPath.test(request.path)) {
    throw new Error(`capture line ${index + 1} is not an allowlisted user-scoped GET`);
  }
  if (typeof request.params !== "object" || request.params === null || Array.isArray(request.params)) {
    throw new Error(`capture line ${index + 1} has invalid request params`);
  }
  if (!Number.isInteger(response?.status_code) || !("json" in response)) {
    throw new Error(`capture line ${index + 1} has an invalid response`);
  }
}

const serialized = JSON.stringify(records);
for (const forbidden of ["ontrack.infotech.monash.edu", "Auth-Token", "refresh_token", "access_token", "authentication_token", "cookie"]) {
  if (serialized.toLowerCase().includes(forbidden.toLowerCase())) throw new Error(`capture contains forbidden value ${forbidden}`);
}

const destination = join(process.cwd(), "tests", "golden", "sources", sourceId);
await mkdir(destination);
const digest = createHash("sha256").update(capture).digest("hex");
const metadata = {
  schema: 1,
  kind: "python_oracle",
  live_recorded: true,
  description: "Sanitized user-scoped responses recorded from the final Python oracle; session identity is substituted.",
  fixture: "http.json",
  session: "session.json",
  oracle_commit: oracleCommit,
  recorded_at: new Date(recordedAt).toISOString(),
  capture_sha256: digest,
};
const session = {
  base_url: "https://school.example.invalid",
  username: "recorded-user",
};
await Promise.all([
  writeFile(join(destination, "source.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
  writeFile(join(destination, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8"),
  writeFile(join(destination, "http.json"), `${JSON.stringify(records, null, 2)}\n`, "utf8"),
]);
process.stdout.write(`Imported ${records.length} sanitized records into ${destination}\n`);
