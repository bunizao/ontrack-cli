import type { ProjectSnapshot } from "./project-snapshot.js";
import type { Project, ProjectSummary, Task, TaskDefinition, Unit, UnitRole, UnitSummary, UserView } from "./types.js";

function text(value: { toString(): string } | null | undefined): string | null {
  return value?.toString() ?? null;
}

export function userToJson(user: UserView): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    nickname: user.nickname,
  };
}

export function unitSummaryToJson(unit: UnitSummary): Record<string, unknown> {
  return {
    id: unit.id,
    code: unit.code,
    name: unit.name,
    my_role: unit.my_role ?? null,
    start_date: text(unit.start_date),
    end_date: text(unit.end_date),
    active: unit.active ?? null,
  };
}

export function taskToJson(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    task_definition_id: task.task_definition_id,
    status: task.status,
    due_date: text(task.due_date),
    target_due_date: text(task.target_due_date),
    target_start_date: text(task.target_start_date),
    submission_date: text(task.submission_date),
    completion_date: text(task.completion_date),
    moved_to_discuss_at: text(task.moved_to_discuss_at),
    discuss_timeout_expiry_at: text(task.discuss_timeout_expiry_at),
    extensions: task.extensions,
    times_assessed: task.times_assessed,
    grade: task.grade,
    quality_pts: task.quality_pts,
    include_in_portfolio: task.include_in_portfolio,
  };
}

export function taskDefinitionToJson(definition: TaskDefinition): Record<string, unknown> {
  return {
    id: definition.id,
    abbreviation: definition.abbreviation,
    name: definition.name,
    description: definition.description,
    target_grade: definition.target_grade,
    start_date: text(definition.start_date),
    target_date: text(definition.target_date),
    due_date: text(definition.due_date),
    is_graded: definition.is_graded,
    max_quality_pts: definition.max_quality_pts,
    grade_due_dates: Object.entries(definition.grade_due_dates).map(([targetGrade, targetDueDate]) => ({
      target_grade: Number(targetGrade),
      target_due_date: targetDueDate.toString(),
      start_date: definition.grade_start_dates[targetGrade]?.toString() ?? null,
    })),
  };
}

export function projectSummaryToJson(project: ProjectSummary): Record<string, unknown> {
  return {
    id: project.id,
    unit: unitSummaryToJson(project.unit),
    target_grade: project.target_grade,
    portfolio_available: project.portfolio_available,
    user_id: project.user_id,
    unit_id: project.unit_id,
  };
}

export function projectToJson(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    unit: unitSummaryToJson(project.unit),
    target_grade: project.target_grade,
    submitted_grade: project.submitted_grade,
    compile_portfolio: project.compile_portfolio,
    portfolio_available: project.portfolio_available,
    uses_draft_learning_summary: project.uses_draft_learning_summary,
    tasks: project.tasks.map(taskToJson),
  };
}

export function unitToJson(unit: Unit): Record<string, unknown> {
  return {
    summary: unitSummaryToJson(unit),
    description: unit.description ?? null,
    grade_definitions: unit.grade_definitions.map((definition) => ({
      id: definition.id,
      value: definition.value,
      label: definition.name,
      abbreviation: definition.abbreviation,
    })),
    task_definitions: unit.task_definitions.map(taskDefinitionToJson),
  };
}

export function roleToJson(role: UnitRole): Record<string, unknown> {
  return {
    id: role.id,
    role: role.role,
    unit: unitSummaryToJson(role.unit),
    user: role.user ? userToJson(role.user) : null,
  };
}

export function snapshotToJson(snapshot: ProjectSnapshot): Record<string, unknown> {
  return {
    project: projectToJson(snapshot.project),
    unit: unitToJson(snapshot.unit),
    tasks: snapshot.tasks.map((task) => ({ ...task })),
  };
}
