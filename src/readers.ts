import { CliError } from "./errors.js";
import { readGradeDefinitions } from "./grades.js";
import { CivilDate, Instant } from "./time.js";
import type {
  Project,
  ProjectSummary,
  Task,
  TaskDefinition,
  Unit,
  UnitRole,
  UnitSummary,
  UserView,
} from "./types.js";

type Data = Record<string, unknown>;

function contract(message: string): never {
  throw new CliError("upstream_contract", message);
}

function object(value: unknown, name: string): Data {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return contract(`${name} must be an object`);
  return value as Data;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) return contract(`${name} must be an array`);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return contract(`${name} must be a number`);
  return value;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) return contract(`${name} must be a positive safe integer`);
  return value as number;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") return contract(`${name} must be a string`);
  return value;
}

function nullableNumber(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  return requiredNumber(value, name);
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) return contract(`${name} must be a non-negative safe integer`);
  return value as number;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, name);
}

function nullableBoolean(value: unknown, name: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") return contract(`${name} must be a boolean`);
  return value;
}

function civilDate(value: unknown, name: string): CivilDate | null {
  const text = nullableString(value, name);
  if (text === null) return null;
  try {
    return CivilDate.parse(text);
  } catch {
    return contract(`${name} must be a civil date`);
  }
}

function instant(value: unknown, name: string): Instant | null {
  const text = nullableString(value, name);
  if (text === null) return null;
  try {
    return Instant.parse(text);
  } catch {
    return contract(`${name} must be an instant`);
  }
}

export function readUnitSummary(value: unknown): UnitSummary {
  const data = object(value, "unit");
  return {
    id: requiredPositiveInteger(data.id, "unit id"),
    code: requiredString(data.code, "unit code"),
    name: requiredString(data.name, "unit name"),
    my_role: nullableString(data.my_role, "unit my_role"),
    start_date: civilDate(data.start_date, "unit start_date"),
    end_date: civilDate(data.end_date, "unit end_date"),
    active: nullableBoolean(data.active, "unit active"),
    allow_flexible_dates: nullableBoolean(data.allow_flexible_dates, "unit allow_flexible_dates"),
  };
}

function readTask(value: unknown): Task {
  const data = object(value, "task");
  return {
    id: requiredPositiveInteger(data.id, "task id"),
    task_definition_id: requiredPositiveInteger(data.task_definition_id, "task task_definition_id"),
    status: requiredString(data.status, "task status"),
    due_date: civilDate(data.due_date, "task due_date"),
    target_due_date: civilDate(data.target_due_date, "task target_due_date"),
    target_start_date: civilDate(data.target_start_date, "task target_start_date"),
    submission_date: civilDate(data.submission_date, "task submission_date"),
    completion_date: civilDate(data.completion_date, "task completion_date"),
    moved_to_discuss_at: instant(data.moved_to_discuss_at, "task moved_to_discuss_at"),
    discuss_timeout_expiry_at: instant(data.discuss_timeout_expiry_at, "task discuss_timeout_expiry_at"),
    extensions: nullableNumber(data.extensions, "task extensions"),
    times_assessed: nullableNumber(data.times_assessed, "task times_assessed"),
    grade: nullableNumber(data.grade, "task grade"),
    quality_pts: nullableNumber(data.quality_pts, "task quality_pts"),
    include_in_portfolio: nullableBoolean(data.include_in_portfolio, "task include_in_portfolio"),
    num_new_comments: nonnegativeInteger(data.num_new_comments, "task num_new_comments"),
  };
}

function readTaskDefinition(value: unknown): TaskDefinition {
  const data = object(value, "task definition");
  const gradeDueDates: Record<string, CivilDate> = {};
  const gradeStartDates: Record<string, CivilDate> = {};
  for (const entry of data.grade_due_dates === undefined ? [] : array(data.grade_due_dates, "grade_due_dates")) {
    const override = object(entry, "grade due date");
    const grade = requiredNumber(override.target_grade, "grade due date target_grade");
    const due = civilDate(override.target_due_date, "grade due date target_due_date");
    const start = civilDate(override.start_date, "grade due date start_date");
    if (due) gradeDueDates[String(grade)] = due;
    if (start) gradeStartDates[String(grade)] = start;
  }
  return {
    id: requiredPositiveInteger(data.id, "task definition id"),
    abbreviation: requiredString(data.abbreviation, "task definition abbreviation"),
    name: requiredString(data.name, "task definition name"),
    description: nullableString(data.description, "task definition description"),
    target_grade: nullableNumber(data.target_grade, "task definition target_grade"),
    start_date: civilDate(data.start_date, "task definition start_date"),
    target_date: civilDate(data.target_date, "task definition target_date"),
    due_date: civilDate(data.due_date, "task definition due_date"),
    is_graded: nullableBoolean(data.is_graded, "task definition is_graded"),
    max_quality_pts: nullableNumber(data.max_quality_pts, "task definition max_quality_pts"),
    has_task_sheet: nullableBoolean(data.has_task_sheet, "task definition has_task_sheet"),
    has_task_resources: nullableBoolean(data.has_task_resources, "task definition has_task_resources"),
    grade_due_dates: gradeDueDates,
    grade_start_dates: gradeStartDates,
  };
}

export function readProjects(value: unknown): ProjectSummary[] {
  return array(value, "projects").map((item) => {
    const data = object(item, "project summary");
    return {
      id: requiredPositiveInteger(data.id, "project id"),
      unit: readUnitSummary(data.unit),
      target_grade: nullableNumber(data.target_grade, "project target_grade"),
      portfolio_available: nullableBoolean(data.portfolio_available, "project portfolio_available"),
      user_id: nullableNumber(data.user_id, "project user_id"),
      unit_id: nullableNumber(data.unit_id, "project unit_id"),
    };
  });
}

export function readProject(value: unknown): Project {
  const data = object(value, "project");
  const unit = readUnitSummary(data.unit);
  return {
    id: requiredPositiveInteger(data.id, "project id"),
    unit,
    target_grade: nullableNumber(data.target_grade, "project target_grade"),
    submitted_grade: nullableNumber(data.submitted_grade, "project submitted_grade"),
    compile_portfolio: nullableBoolean(data.compile_portfolio, "project compile_portfolio"),
    portfolio_available: nullableBoolean(data.portfolio_available, "project portfolio_available"),
    uses_draft_learning_summary: nullableBoolean(data.uses_draft_learning_summary, "project uses_draft_learning_summary"),
    flexible_dates: unit.allow_flexible_dates ?? false,
    special_consideration_days: nullableNumber(data.spec_con_days, "project spec_con_days") ?? 0,
    tasks: array(data.tasks, "project tasks").map(readTask),
  };
}

export function readUnit(value: unknown): Unit {
  const data = object(value, "unit");
  const summary = readUnitSummary(data);
  let definitions;
  try {
    definitions = readGradeDefinitions(data.grade_definitions);
  } catch (error) {
    return contract(error instanceof Error ? error.message : "Invalid grade_definitions");
  }
  return {
    ...summary,
    description: nullableString(data.description, "unit description"),
    grade_definitions: definitions,
    task_definitions: array(data.task_definitions, "unit task_definitions").map(readTaskDefinition),
  };
}

function readUser(value: unknown): UserView {
  const data = object(value, "user");
  return {
    id: nullableNumber(data.id, "user id"),
    username: nullableString(data.username, "user username"),
    first_name: nullableString(data.first_name ?? data.firstName, "user first_name"),
    last_name: nullableString(data.last_name ?? data.lastName, "user last_name"),
    email: nullableString(data.email, "user email"),
    nickname: nullableString(data.nickname, "user nickname"),
  };
}

export function readRoles(value: unknown): UnitRole[] {
  return array(value, "roles").map((item) => {
    const data = object(item, "role");
    return {
      id: requiredPositiveInteger(data.id, "role id"),
      role: requiredString(data.role, "role role"),
      unit: readUnitSummary(data.unit),
      user: data.user === undefined || data.user === null ? null : readUser(data.user),
    };
  });
}
