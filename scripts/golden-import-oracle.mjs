import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const oracleCommit = "06e0c4b6d45cdda4e999e4c829d61bfe8392ef8c";
const allowedFields = new Set([
  "abbreviation", "active", "assess_in_portfolio", "can_mark_overflow_tasks", "code", "compile_portfolio", "completion_date",
  "description", "discuss_timeout_expiry_at", "due_date", "end_date", "error", "extensions", "grade",
  "grade_definitions", "id", "include_in_portfolio", "is_graded", "max_quality_pts", "message", "method",
  "mentor_id", "moved_to_discuss_at", "my_role", "name", "observer_only", "portfolio_available", "project_id",
  "quality_pts", "role", "start_date", "status", "submission_date", "submitted_grade", "target_date", "target_due_date",
  "target_grade", "target_start_date", "task_definition_id", "task_definitions", "tasks", "times_assessed",
  "tutor_note_count", "unit", "unit_id",
  "user", "user_id", "username", "first_name", "last_name", "email", "nickname",
  "uses_draft_learning_summary",
]);
const idFields = new Set(["id", "mentor_id", "project_id", "task_definition_id", "unit_id", "user_id"]);
const dateFields = new Set(["completion_date", "due_date", "end_date", "start_date", "submission_date", "target_date", "target_due_date", "target_start_date"]);
const instantFields = new Set(["discuss_timeout_expiry_at", "moved_to_discuss_at"]);
const booleanFields = new Set(["active", "assess_in_portfolio", "can_mark_overflow_tasks", "compile_portfolio", "include_in_portfolio", "is_graded", "observer_only", "portfolio_available", "uses_draft_learning_summary"]);
const numberFields = new Set(["extensions", "grade", "max_quality_pts", "quality_pts", "submitted_grade", "target_grade", "times_assessed", "tutor_note_count"]);
const enumFields = new Set(["method", "my_role", "role", "status"]);
const textSubstitutions = new Map([
  ["abbreviation", "TASK"], ["code", "UNIT"], ["description", "Description"], ["error", "API error"],
  ["message", "API message"], ["name", "Unit"], ["username", "recorded-user"],
  ["first_name", "Recorded"], ["last_name", "User"], ["email", "recorded-user@example.invalid"],
  ["nickname", "Recorded"],
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

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
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

const allowedPaths = new Set([
  "/api/auth/method",
  "/api/projects",
  "/api/projects/1",
  "/api/unit_roles",
  "/api/units/1",
]);
const userScopedPath = /^\/api\/(?:auth\/method|projects(?:\/\d+)?|unit_roles|units\/\d+)$/u;
for (const [index, record] of records.entries()) {
  if (!hasExactKeys(record, ["request", "response"])
    || !hasExactKeys(record.request, ["method", "params", "path"])
    || !hasExactKeys(record.response, ["json", "status_code"])) {
    throw new Error(`capture line ${index + 1} has unexpected record fields`);
  }
  const request = record?.request;
  const response = record?.response;
  if (request?.method !== "GET" || typeof request.path !== "string" || !userScopedPath.test(request.path)) {
    throw new Error(`capture line ${index + 1} is not an allowlisted user-scoped GET`);
  }
  if (!allowedPaths.has(request.path)) {
    throw new Error(`capture line ${index + 1} request path was not sanitized`);
  }
  if (typeof request.params !== "object" || request.params === null || Array.isArray(request.params)) {
    throw new Error(`capture line ${index + 1} has invalid request params`);
  }
  const booleanParam = request.path === "/api/projects"
    ? "include_inactive"
    : request.path === "/api/unit_roles" ? "active_only" : null;
  const expectedParams = booleanParam ? { [booleanParam]: request.params[booleanParam] } : {};
  if (booleanParam && typeof request.params[booleanParam] !== "boolean") {
    throw new Error(`capture line ${index + 1} request params were not sanitized`);
  }
  if (JSON.stringify(request.params) !== JSON.stringify(expectedParams)) {
    throw new Error(`capture line ${index + 1} request params were not sanitized`);
  }
  if (!Number.isInteger(response.status_code) || response.status_code < 100 || response.status_code > 599) {
    throw new Error(`capture line ${index + 1} has an invalid response`);
  }
  const objectBody = response.json !== null && typeof response.json === "object" && !Array.isArray(response.json);
  const listBody = Array.isArray(response.json)
    && response.json.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
  const successfulList = (request.path === "/api/projects" || request.path === "/api/unit_roles")
    && response.status_code >= 200 && response.status_code < 300;
  if (successfulList ? !listBody : !objectBody) {
    throw new Error(`capture line ${index + 1} has an invalid response body`);
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
