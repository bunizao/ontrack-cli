import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const provenance = JSON.parse(await readFile(new URL("../tests/golden/oracle-provenance.json", import.meta.url), "utf8"));
export const oracleCommit = provenance.python_release_commit;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const rawTaskExemptFields = new Set([
  "discuss_timeout_expiry_at",
  "moved_to_discuss_at",
  "target_due_date",
  "target_start_date",
]);
const taskRowRemovedFields = new Set([
  ...rawTaskExemptFields,
  "is_discuss_overdue",
]);
const taskRowNormalizedFields = new Set([
  "deadline",
  "due_date",
  "grade_label",
  "is_overdue",
  "start_date",
  "status_label",
  "target_grade_label",
]);
function objectWithout(value, excluded) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}

function projectTaskRow(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !taskRowRemovedFields.has(key))
    .map(([key, item]) => [key, taskRowNormalizedFields.has(key) ? null : item]));
}

function sortingValue(value) {
  if (Array.isArray(value)) return value.map(sortingValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, sortingValue(item)]));
}

function projectedList(value, projection) {
  if (!Array.isArray(value)) return value;
  return value.map(projection).sort((left, right) => {
    const leftText = JSON.stringify(sortingValue(left));
    const rightText = JSON.stringify(sortingValue(right));
    return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
  });
}

function projectedItems(value, projection) {
  return Array.isArray(value) ? value.map(projection) : value;
}

function projectProjectCommand(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value };
  if (result.project !== null && typeof result.project === "object" && !Array.isArray(result.project)) {
    result.project = {
      ...result.project,
      tasks: projectedItems(result.project.tasks, (task) => objectWithout(task, rawTaskExemptFields)),
    };
  }
  result.tasks = projectedList(result.tasks, projectTaskRow);
  return result;
}

export function parityProjection(caseName, value) {
  const command = caseName.split("/", 1)[0];
  const projected = command === "tasks"
    ? projectedList(value, projectTaskRow)
    : command === "project" ? projectProjectCommand(value) : value;
  return projected;
}

export function projectionJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function isSafeRelativePath(value) {
  return typeof value === "string"
    && /^[a-z][a-z-]*\/[a-z0-9][a-z0-9-]*$/u.test(value);
}

export function isSafeArtifactPath(value) {
  return typeof value === "string"
    && /^commands\/[a-z][a-z-]*\/[a-z0-9][a-z0-9-]*\.json$/u.test(value);
}

function validateIdentity(key, value) {
  const substitutions = {
    username: new Set(["recorded-user", "synthetic-student"]),
    first_name: new Set(["Recorded", "Example"]),
    last_name: new Set(["User", "Student"]),
    email: new Set(["recorded-user@example.invalid", "student@example.invalid"]),
    nickname: new Set(["Recorded", "Example"]),
    base_url: new Set(["https://school.example.invalid"]),
    abbreviation: new Set(["TASK"]),
    code: new Set(["UNIT"]),
    description: new Set(["Description"]),
    name: new Set(["Unit"]),
  };
  if (!(key in substitutions) || value === null) return;
  if (!substitutions[key].has(value)) throw new Error(`Python stdout contains forbidden identity field ${key}`);
}

const recordedIdFields = new Set(["id", "mentor_id", "project_id", "task_definition_id", "unit_id", "user_id"]);
const safeEnumValues = new Map([
  ["auth_method", new Set(["recorded_method", "saml"])],
  ["method", new Set(["recorded_method", "saml"])],
  ["my_role", new Set(["Admin", "Auditor", "Convenor", "Lecturer", "Moderator", "Observer", "Recorded Role", "Student", "Tutor", "Unit Coordinator"])],
  ["role", new Set(["Admin", "Auditor", "Convenor", "Lecturer", "Moderator", "Observer", "Recorded Role", "Student", "Tutor", "Unit Coordinator"])],
]);
const recordedDateFields = new Set([
  "completion_date", "deadline", "discuss_timeout_expiry_at", "due_date", "end_date", "moved_to_discuss_at",
  "start_date", "submission_date", "target_date", "target_due_date", "target_start_date",
]);
const derivedLabelFields = new Set(["grade_label", "status_label", "target_grade_label"]);
const pythonStatusLabels = new Map([
  ["ready_for_feedback", "Ready for Feedback"], ["not_started", "Not Started"], ["working_on_it", "Working On It"],
  ["need_help", "Need Help"], ["redo", "Redo"], ["feedback_exceeded", "Feedback Exceeded"],
  ["fix_and_resubmit", "Resubmit"], ["discuss", "Discuss"], ["demonstrate", "Demonstrate"],
  ["complete", "Complete"], ["fail", "Fail"], ["time_exceeded", "Time Exceeded"],
]);
const safeStatusKeys = new Set([
  ...pythonStatusLabels.keys(),
  "assess_in_portfolio",
  "attention_required",
  "future_status_2027",
  "rediscuss",
]);
const safeGradeLabel = /^(?:-|F \(Fail\)|P \(Pass\)|C \(Credit\)|D \(Distinction\)|HD \(High Distinction\)|TASK \(Unit\)|-?\d+)$/u;

function validateValue(value, key = "") {
  if (Array.isArray(value)) {
    for (const item of value) validateValue(item, key);
    return;
  }
  if (value !== null && typeof value === "object") {
    if (value.status_label !== undefined && typeof value.status !== "string") {
      throw new Error("Python stdout status label requires a status key");
    }
    if (typeof value.status === "string") {
      if (!safeStatusKeys.has(value.status)) throw new Error("Python stdout contains invalid status key");
      if (value.status_label !== undefined && value.status_label !== null
        && value.status_label !== (pythonStatusLabels.get(value.status) ?? value.status)) {
        throw new Error("Python stdout contains invalid status label");
      }
    }
    for (const labelKey of ["grade_label", "target_grade_label"]) {
      if (value[labelKey] !== undefined && value[labelKey] !== null
        && (typeof value[labelKey] !== "string" || !safeGradeLabel.test(value[labelKey]))) {
        throw new Error(`Python stdout contains invalid grade label ${labelKey}`);
      }
    }
    for (const [childKey, child] of Object.entries(value)) {
      if (/(?:token|cookie|password|secret|authorization)/iu.test(childKey)) {
        throw new Error(`Python stdout contains forbidden credential field ${childKey}`);
      }
      validateIdentity(childKey, child);
      validateValue(child, childKey);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (/ontrack\.infotech\.monash\.edu|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}/iu.test(value)) {
    throw new Error(`Python stdout contains a forbidden value in ${key || "output"}`);
  }
  if (value.includes("@") && !/@example\.invalid$/iu.test(value)) {
    throw new Error(`Python stdout contains forbidden identity text in ${key || "output"}`);
  }
  if (key === "status") {
    if (!safeStatusKeys.has(value)) throw new Error("Python stdout contains invalid status key");
    return;
  }
  if (safeEnumValues.has(key)) {
    if (!safeEnumValues.get(key).has(value)) throw new Error(`Python stdout contains invalid enum text in ${key}`);
    return;
  }
  if (recordedDateFields.has(key)) {
    if (!/^\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?$/u.test(value)) throw new Error(`Python stdout contains invalid date text in ${key}`);
    return;
  }
  if (derivedLabelFields.has(key)) return;
  if (["username", "first_name", "last_name", "email", "nickname", "base_url", "abbreviation", "code", "description", "name"].includes(key)) return;
  throw new Error(`Python stdout contains unallowlisted text field ${key || "output"}`);
}

export function validateSanitizedJsonStdout(stdout) {
  if (!stdout.endsWith("\n")) throw new Error("Python stdout must end with one newline");
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Python stdout must contain only valid JSON");
  }
  if (value === null || typeof value !== "object") throw new Error("Python stdout JSON must be an object or array");
  const validateRecordedIds = (item, key = "") => {
    if (Array.isArray(item)) {
      for (const child of item) validateRecordedIds(child, key);
    } else if (item !== null && typeof item === "object") {
      for (const [childKey, child] of Object.entries(item)) validateRecordedIds(child, childKey);
    } else if (recordedIdFields.has(key) && item !== null
      && (!Number.isSafeInteger(item) || item < 1)) {
      throw new Error(`Python stdout contains invalid pseudonym identifier ${key}`);
    }
  };
  validateRecordedIds(value);
  validateValue(value);
  return value;
}

export function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
