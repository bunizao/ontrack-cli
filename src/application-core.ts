import { CliError } from "./errors.js";
import type { DownloadResponse } from "./http.js";
import type { OnTrackClient } from "./ontrack.js";
import { buildProjectSnapshot, type ProjectSnapshot, type TaskRow } from "./project-snapshot.js";
import { projectSummaryToJson, roleToJson, snapshotToJson, userToJson } from "./serialize.js";
import { writableTaskState, type WritableTaskState } from "./status.js";
import type { Clock } from "./time.js";
import type { ProjectSummary, TaskDefinition, UserView } from "./types.js";

// What the CLI and the remote MCP Worker share: reads and small writes on OnTrack,
// with no file system. Runtime-neutral, checked by tsconfig.core.json.

/** The signed-in identity, as much of the session as these commands need. */
export interface SessionView {
  readonly baseUrl: string;
  readonly username: string;
  readonly user?: UserView | null | undefined;
}

export interface SessionState {
  current: SessionView;
}

export interface TaskSheet {
  readonly project_id: number;
  readonly unit_id: number;
  readonly task_definition_id: number;
  readonly task: string;
  /** UNIT-TASK.pdf, the name `ontrack tasks get` saves it under. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface ChatSendConfirmation {
  readonly projectId: number;
  readonly taskDefinitionId: number;
  readonly task: string;
  readonly message: string;
}

export function selectedTask(snapshot: ProjectSnapshot, reference: string): { readonly row: TaskRow; readonly definition: TaskDefinition } {
  const row = assignedTask(snapshot, reference);
  const definition = row && snapshot.unit.task_definitions.find((candidate) => candidate.id === row.task_definition_id);
  if (!row || !definition) {
    throw new CliError("not_found", `Task ${reference} is not in project ${snapshot.project.id}. Use the abbreviation shown by \`ontrack tasks ${snapshot.project.id}\`.`);
  }
  return { row, definition };
}

export function assignedTask(snapshot: ProjectSnapshot, reference: string): TaskRow | undefined {
  const normalized = reference.trim().toLowerCase();
  const byAbbreviation = snapshot.tasks.find((task) => task.abbreviation.toLowerCase() === normalized);
  if (byAbbreviation) return byAbbreviation;
  const numericId = /^\d+$/u.test(normalized) ? Number(normalized) : undefined;
  return numericId === undefined ? undefined : snapshot.tasks.find((task) => task.task_definition_id === numericId);
}

export function selectedDownloadTask(
  snapshot: ProjectSnapshot,
  reference: string,
): { readonly abbreviation: string; readonly definition: TaskDefinition } {
  const normalized = reference.trim().toLowerCase();
  const numericId = /^\d+$/u.test(normalized) ? Number(normalized) : undefined;
  const assigned = assignedTask(snapshot, reference);
  const unitDefinition = snapshot.unit.task_definitions.find((candidate) => candidate.abbreviation.toLowerCase() === normalized)
    ?? (numericId === undefined ? undefined : snapshot.unit.task_definitions.find((candidate) => candidate.id === numericId));
  const definition = assigned
    ? snapshot.unit.task_definitions.find((candidate) => candidate.id === assigned.task_definition_id)
    : snapshot.tasks.length === 0
      ? unitDefinition
      : undefined;
  if (!definition) {
    throw new CliError("not_found", `Task ${reference} is not available in project ${snapshot.project.id}. Use an abbreviation shown by \`ontrack units show ${snapshot.project.id}\`.`);
  }
  return { abbreviation: definition.abbreviation, definition };
}

export function placeholderFile(filename: string | null): boolean {
  return filename?.toLowerCase() === "filenotfound.pdf";
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
}

export function taskSheetTask(snapshot: ProjectSnapshot, reference: string): { readonly abbreviation: string; readonly definition: TaskDefinition } {
  const selected = selectedDownloadTask(snapshot, reference);
  if (selected.definition.has_task_sheet === false) {
    throw new CliError("upstream_api", `Task ${selected.abbreviation} has no task sheet.`);
  }
  return selected;
}

// Exact code first, then a unique substring of the code or the unit name.
// The site's unit list is the vocabulary; no code format is assumed.
function matchingProjects(projects: readonly ProjectSummary[], query: string): ProjectSummary[] {
  const exact = projects.filter((project) => project.unit.code.toLowerCase() === query);
  if (exact.length > 0) return exact;
  return projects.filter((project) =>
    project.unit.code.toLowerCase().includes(query) || project.unit.name.toLowerCase().includes(query));
}

export class OnTrackService {
  constructor(
    protected readonly sessionState: SessionState,
    protected readonly client: OnTrackClient,
    protected readonly clock: Clock,
  ) {}

  async resolveProject(reference: string): Promise<number> {
    const query = reference.trim().toLowerCase();
    const active = matchingProjects(await this.client.getProjects(false), query);
    if (active.length === 1) return active[0]!.id;
    if (active.length > 1) throw this.ambiguousProject(reference, active.map((project) => project.id));
    const everything = await this.client.getProjects(true);
    const all = matchingProjects(everything, query);
    if (all.length === 1) return all[0]!.id;
    if (all.length > 1) throw this.ambiguousProject(reference, all.map((project) => project.id));
    const known = [...new Set(everything.map((project) => project.unit.code))].join(", ");
    throw new CliError("not_found", `No unit matches ${reference.trim()}. Your units: ${known || "none"}. Use \`ontrack units list --include-inactive\` for project IDs.`);
  }

  async user(): Promise<unknown> {
    // The identity below comes from cached session state, and api/auth/method is
    // unauthenticated, so one protected endpoint is read to prove the session is
    // still live. getProjects is memoized, so a later command reuses this answer.
    const [authMethod] = await Promise.all([
      this.client.getAuthMethod(),
      this.client.getProjects(true),
    ]);
    const session = this.sessionState.current;
    if (session.user) {
      return {
        ...userToJson(session.user),
        base_url: session.baseUrl,
        auth_method: authMethod.method,
      };
    }
    return {
      username: session.username,
      base_url: session.baseUrl,
      auth_method: authMethod.method,
    };
  }

  async authCheck(): Promise<unknown> {
    const [authMethod, projects, roles] = await Promise.all([
      this.client.getAuthMethod(),
      this.client.getProjects(true),
      this.client.getRoles(false),
    ]);
    return {
      base_url: this.sessionState.current.baseUrl,
      username: this.sessionState.current.username,
      auth_method: authMethod.method,
      projects: projects.length,
      unit_roles: roles.length,
      cached_user: this.sessionState.current.user ? userToJson(this.sessionState.current.user) : null,
    };
  }

  async projects(options: { readonly includeInactive: boolean }): Promise<unknown> {
    return (await this.client.getProjects(options.includeInactive)).map(projectSummaryToJson);
  }

  async project(projectId: number): Promise<unknown> {
    return snapshotToJson(await this.snapshot(projectId));
  }

  async tasks(projectId: number, options: { readonly statuses: readonly string[] }): Promise<unknown> {
    let tasks = (await this.snapshot(projectId)).tasks;
    if (options.statuses.length > 0) {
      const allowed = new Set(options.statuses);
      tasks = tasks.filter((task) => allowed.has(task.status));
    }
    return tasks.map((task) => ({ ...task }));
  }

  async taskShow(projectId: number, task: string): Promise<unknown> {
    const selected = selectedTask(await this.snapshot(projectId), task);
    return {
      ...selected.row,
      description: selected.definition.description,
      has_task_sheet: selected.definition.has_task_sheet,
      has_task_resources: selected.definition.has_task_resources,
      upload_requirements: selected.definition.upload_requirements,
    };
  }

  async chats(projectId: number, options: { readonly task?: string }): Promise<unknown> {
    const snapshot = await this.snapshot(projectId);
    if (options.task) {
      const selected = selectedTask(snapshot, options.task);
      return this.client.getTaskComments(projectId, selected.definition.id);
    }
    const unreadByTaskDefinition = new Map(
      snapshot.project.tasks.map((task) => [task.task_definition_id, task.num_new_comments ?? 0]),
    );
    return snapshot.tasks.map((row) => {
      return {
        task_definition_id: row.task_definition_id,
        task: row.abbreviation,
        name: row.name,
        status: row.status,
        unread_comments: unreadByTaskDefinition.get(row.task_definition_id) ?? 0,
      };
    });
  }

  async chatMarkRead(projectId: number, task: string): Promise<unknown> {
    const snapshot = await this.snapshot(projectId);
    const selected = selectedTask(snapshot, task);
    const comments = await this.client.getTaskComments(projectId, selected.definition.id);
    return {
      project_id: projectId,
      task_definition_id: selected.definition.id,
      task: selected.definition.abbreviation,
      comments: comments.length,
      marked_read: true,
    };
  }

  async prepareChatSend(projectId: number, task: string, message: string): Promise<ChatSendConfirmation> {
    const snapshot = await this.snapshot(projectId);
    const selected = selectedTask(snapshot, task);
    return { projectId, taskDefinitionId: selected.definition.id, task: selected.definition.abbreviation, message };
  }

  async chatSend(plan: ChatSendConfirmation): Promise<unknown> {
    const comment = await this.client.addTaskComment(plan.projectId, plan.taskDefinitionId, plan.message);
    return {
      project_id: plan.projectId,
      task_definition_id: plan.taskDefinitionId,
      task: plan.task,
      comment_id: comment.id,
      message: comment.comment,
      created_at: comment.created_at,
    };
  }

  async roles(options: { readonly showAll: boolean }): Promise<unknown> {
    return (await this.client.getRoles(!options.showAll)).map(roleToJson);
  }

  async taskState(projectId: number, task: string, state: WritableTaskState): Promise<unknown> {
    const parsedState = writableTaskState(state);
    const snapshot = await this.snapshot(projectId);
    const selected = selectedTask(snapshot, task);
    const updated = await this.client.updateTaskState(projectId, selected.definition.id, parsedState);
    if (updated.task_definition_id !== selected.definition.id || updated.status !== parsedState) {
      throw new CliError("upstream_contract", `OnTrack did not update task ${selected.definition.abbreviation} to ${parsedState}`);
    }
    return {
      project_id: projectId,
      task_definition_id: selected.definition.id,
      task: selected.definition.abbreviation,
      previous_status: selected.row.status,
      status: updated.status,
    };
  }

  /** The task sheet's PDF, for a reader that converts it itself. */
  async taskSheet(projectId: number, task: string): Promise<TaskSheet> {
    const snapshot = await this.snapshot(projectId);
    const selected = taskSheetTask(snapshot, task);
    const download = await this.downloadTaskSheet(snapshot, selected);
    return {
      project_id: projectId,
      unit_id: snapshot.unit.id,
      task_definition_id: selected.definition.id,
      task: selected.abbreviation,
      name: `${snapshot.unit.code}-${selected.abbreviation}.pdf`,
      bytes: download.bytes,
    };
  }

  protected async downloadTaskSheet(snapshot: ProjectSnapshot, selected: { readonly abbreviation: string; readonly definition: TaskDefinition }): Promise<DownloadResponse> {
    const download = await this.client.downloadTaskSheet(snapshot.unit.id, selected.definition.id);
    if (placeholderFile(download.filename)) throw new CliError("upstream_api", `Task ${selected.abbreviation} has no task sheet.`);
    if (download.contentType !== "application/pdf" || !isPdf(download.bytes)) {
      throw new CliError("upstream_contract", "OnTrack returned an invalid task sheet PDF");
    }
    return download;
  }

  protected async snapshot(projectId: number) {
    const project = await this.client.getProject(projectId);
    const unit = await this.client.getUnit(project.unit.id);
    return buildProjectSnapshot(
      { ...project, flexible_dates: unit.allow_flexible_dates ?? project.flexible_dates },
      unit,
      this.clock,
    );
  }

  private ambiguousProject(reference: string, projectIds: readonly number[]): CliError {
    const ids = [...new Set(projectIds)].sort((left, right) => left - right);
    return new CliError("usage", `Unit ${reference.trim()} matches multiple projects: ${ids.join(", ")}. Use a project ID.`);
  }
}
