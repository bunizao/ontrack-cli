import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const oracleCommit = "06e0c4b6d45cdda4e999e4c829d61bfe8392ef8c";
const allowedFields = new Set([
  "abbreviation", "active", "assess_in_portfolio", "code", "compile_portfolio", "completion_date",
  "description", "discuss_timeout_expiry_at", "due_date", "end_date", "error", "extensions", "grade",
  "grade_definitions", "id", "include_in_portfolio", "is_graded", "max_quality_pts", "message", "method",
  "moved_to_discuss_at", "my_role", "name", "portfolio_available", "project_id", "quality_pts", "role",
  "start_date", "status", "submission_date", "submitted_grade", "target_date", "target_due_date", "target_grade",
  "target_start_date", "task_definition_id", "task_definitions", "tasks", "times_assessed", "unit", "unit_id",
  "user_id", "uses_draft_learning_summary",
]);
const idFields = new Set(["id", "project_id", "task_definition_id", "unit_id", "user_id"]);
const dateFields = new Set(["completion_date", "due_date", "end_date", "start_date", "submission_date", "target_date", "target_due_date", "target_start_date"]);
const instantFields = new Set(["discuss_timeout_expiry_at", "moved_to_discuss_at"]);
const booleanFields = new Set(["active", "assess_in_portfolio", "compile_portfolio", "include_in_portfolio", "is_graded", "portfolio_available", "uses_draft_learning_summary"]);
const numberFields = new Set(["extensions", "grade", "max_quality_pts", "quality_pts", "submitted_grade", "target_grade", "times_assessed"]);
const enumFields = new Set(["method", "my_role", "role", "status"]);
const textSubstitutions = new Map([
  ["abbreviation", "TASK"], ["code", "UNIT"], ["description", "Description"], ["error", "API error"],
  ["message", "API message"], ["name", "Unit"],
]);

function sanitize(value, field) {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, field));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => allowedFields.has(key))
      .map(([key, item]) => [key, sanitize(item, key)]));
  }
  if (idFields.has(field)) return Number.isInteger(value) ? 1 : null;
  if (dateFields.has(field)) return typeof value === "string" ? "2000-01-01" : null;
  if (instantFields.has(field)) return typeof value === "string" ? "2000-01-01T00:00:00Z" : null;
  if (booleanFields.has(field)) return typeof value === "boolean" ? value : null;
  if (numberFields.has(field)) return typeof value === "number" && Number.isFinite(value) ? value : null;
  if (enumFields.has(field)) return typeof value === "string" ? value : null;
  if (textSubstitutions.has(field)) return typeof value === "string" ? textSubstitutions.get(field) : null;
  return value === null || ["string", "number", "boolean"].includes(typeof value) ? value : null;
}
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
  const sanitized = sanitize(response.json);
  if (JSON.stringify(response.json) !== JSON.stringify(sanitized)) {
    throw new Error(`capture line ${index + 1} was not rebuilt by the Python allowlist sanitizer`);
  }
}

const serialized = JSON.stringify(records);
for (const forbidden of ["ontrack.infotech.monash.edu", "Auth-Token", "refresh_token", "access_token", "authentication_token", "cookie"]) {
  if (serialized.toLowerCase().includes(forbidden.toLowerCase())) throw new Error(`capture contains forbidden value ${forbidden}`);
}

const destination = join(process.cwd(), "tests", "golden", "sources", sourceId);
await mkdir(destination);
const fixtureText = `${JSON.stringify(records, null, 2)}\n`;
const digest = createHash("sha256").update(fixtureText).digest("hex");
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
  writeFile(join(destination, "http.json"), fixtureText, "utf8"),
]);
process.stdout.write(`Imported ${records.length} sanitized records into ${destination}\n`);
