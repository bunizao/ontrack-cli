import type { AuthenticatedSession } from "./auth.js";
import type { CliApplication } from "./cli-app.js";
import type { OnTrackClient } from "./ontrack.js";
import { buildProjectSnapshot } from "./project-snapshot.js";
import { projectSummaryToJson, roleToJson, snapshotToJson, userToJson } from "./serialize.js";
import { assertOutputAvailable, writeDownloadedFile, writeResourceArchive } from "./resources.js";
import { CliError } from "./errors.js";
import type { ProjectSnapshot, TaskRow } from "./project-snapshot.js";
import type { TaskDefinition } from "./types.js";
import type { Clock } from "./time.js";
import { pdfToMarkdown } from "./pdf.js";
import { submissionType, type TaskSubmissionOptions, type TaskSubmissionPlan } from "./submission.js";
import { prepareUploads } from "./uploads.js";

export interface SessionState {
  current: AuthenticatedSession;
}

function selectedTask(snapshot: ProjectSnapshot, reference: string): { readonly row: TaskRow; readonly definition: TaskDefinition } {
  const row = assignedTask(snapshot, reference);
  const definition = row && snapshot.unit.task_definitions.find((candidate) => candidate.id === row.task_definition_id);
  if (!row || !definition) {
    throw new CliError("usage", `Task ${reference} is not in project ${snapshot.project.id}. Use the abbreviation shown by \`ontrack tasks ${snapshot.project.id}\`.`);
  }
  return { row, definition };
}

function assignedTask(snapshot: ProjectSnapshot, reference: string): TaskRow | undefined {
  const normalized = reference.trim().toLowerCase();
  const byAbbreviation = snapshot.tasks.find((task) => task.abbreviation.toLowerCase() === normalized);
  if (byAbbreviation) return byAbbreviation;
  const numericId = /^\d+$/u.test(normalized) ? Number(normalized) : undefined;
  return numericId === undefined ? undefined : snapshot.tasks.find((task) => task.task_definition_id === numericId);
}

function selectedDownloadTask(
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
    throw new CliError("usage", `Task ${reference} is not available in project ${snapshot.project.id}. Use an abbreviation shown by \`ontrack project ${snapshot.project.id}\`.`);
  }
  return { abbreviation: definition.abbreviation, definition };
}

function placeholderFile(filename: string | null): boolean {
  return filename?.toLowerCase() === "filenotfound.pdf";
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
}

const writableTaskStates = ["not_started", "working_on_it", "need_help"] as const;

export class OnTrackApplication implements CliApplication {
  constructor(
    private readonly sessionState: SessionState,
    private readonly client: OnTrackClient,
    private readonly clock: Clock,
    private readonly signal?: AbortSignal,
  ) {}

  async resolveProject(reference: string): Promise<number> {
    const unitCode = reference.trim().toLowerCase();
    const active = (await this.client.getProjects(false)).filter((project) => project.unit.code.toLowerCase() === unitCode);
    if (active.length === 1) return active[0]!.id;
    if (active.length > 1) throw this.ambiguousProject(reference, active.map((project) => project.id));
    const all = (await this.client.getProjects(true)).filter((project) => project.unit.code.toLowerCase() === unitCode);
    if (all.length === 1) return all[0]!.id;
    if (all.length > 1) throw this.ambiguousProject(reference, all.map((project) => project.id));
    throw new CliError("usage", `No project found for unit ${reference}. Use \`ontrack projects --include-inactive\` to find a project ID.`);
  }

  async user(): Promise<unknown> {
    const [authMethod] = await Promise.all([
      this.client.getAuthMethod(),
      this.client.getProjects(true),
      this.client.getRoles(false),
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

  async chatSend(projectId: number, task: string, message: string): Promise<unknown> {
    const snapshot = await this.snapshot(projectId);
    const selected = selectedTask(snapshot, task);
    const comment = await this.client.addTaskComment(projectId, selected.definition.id, message);
    return {
      project_id: projectId,
      task_definition_id: selected.definition.id,
      task: selected.row.abbreviation,
      comment_id: comment.id,
      message: comment.comment,
      created_at: comment.created_at,
    };
  }

  async roles(options: { readonly showAll: boolean }): Promise<unknown> {
    return (await this.client.getRoles(!options.showAll)).map(roleToJson);
  }

  async resourcesDownload(projectId: number, options: { readonly output?: string }): Promise<unknown> {
    const destination = options.output ?? `ontrack-resources-${projectId}.zip`;
    await assertOutputAvailable(destination);
    const archive = await this.client.downloadProjectResources(projectId);
    const archivePath = await writeResourceArchive(
      destination,
      archive.bytes,
      this.signal,
    );
    return {
      project_id: archive.projectId,
      unit_id: archive.unitId,
      archive_path: archivePath,
      bytes_written: archive.bytes.length,
    };
  }

  async taskSheetDownload(projectId: number, task: string, options: { readonly output?: string }): Promise<unknown> {
    const snapshot = await this.snapshot(projectId);
    const selected = selectedDownloadTask(snapshot, task);
    if (selected.definition.has_task_sheet === false) {
      throw new CliError("upstream_api", `Task ${selected.abbreviation} has no task sheet.`);
    }
    const destination = options.output ?? `${snapshot.unit.code}-${selected.abbreviation}.pdf`;
    await assertOutputAvailable(destination);
    const download = await this.client.downloadTaskSheet(snapshot.unit.id, selected.definition.id);
    if (placeholderFile(download.filename)) throw new CliError("upstream_api", `Task ${selected.abbreviation} has no task sheet.`);
    if (download.contentType !== "application/pdf" || !isPdf(download.bytes)) {
      throw new CliError("upstream_contract", "OnTrack returned an invalid task sheet PDF");
    }
    const filePath = await writeDownloadedFile(destination, download.bytes, this.signal);
    return {
      project_id: projectId,
      unit_id: snapshot.unit.id,
      task_definition_id: selected.definition.id,
      task: selected.abbreviation,
      file_path: filePath,
      bytes_written: download.bytes.length,
      content_type: download.contentType,
    };
  }

  async taskResourcesDownload(projectId: number, task: string, options: { readonly output?: string }): Promise<unknown> {
    const snapshot = await this.snapshot(projectId);
    const selected = selectedDownloadTask(snapshot, task);
    if (selected.definition.has_task_resources === false) {
      throw new CliError("upstream_api", `Task ${selected.abbreviation} has no resources.`);
    }
    if (options.output) await assertOutputAvailable(options.output);
    const download = await this.client.downloadTaskResources(snapshot.unit.id, selected.definition.id);
    if (placeholderFile(download.filename)) throw new CliError("upstream_api", `Task ${selected.abbreviation} has no resources.`);
    if (!download.filename && !options.output) {
      throw new CliError("upstream_contract", "OnTrack returned task resources without a filename");
    }
    const destination = options.output ?? download.filename as string;
    if (!options.output) await assertOutputAvailable(destination);
    const filePath = await writeDownloadedFile(destination, download.bytes, this.signal);
    return {
      project_id: projectId,
      unit_id: snapshot.unit.id,
      task_definition_id: selected.definition.id,
      task: selected.abbreviation,
      file_path: filePath,
      bytes_written: download.bytes.length,
      content_type: download.contentType,
    };
  }

  async taskRead(projectId: number, task: string): Promise<unknown> {
    const snapshot = await this.snapshot(projectId);
    const selected = selectedDownloadTask(snapshot, task);
    if (selected.definition.has_task_sheet === false) {
      throw new CliError("upstream_api", `Task ${selected.abbreviation} has no task sheet.`);
    }
    const download = await this.client.downloadTaskSheet(snapshot.unit.id, selected.definition.id);
    if (placeholderFile(download.filename)) throw new CliError("upstream_api", `Task ${selected.abbreviation} has no task sheet.`);
    if (download.contentType !== "application/pdf" || !isPdf(download.bytes)) {
      throw new CliError("upstream_contract", "OnTrack returned an invalid task sheet PDF");
    }
    const document = await pdfToMarkdown(download.bytes, `${snapshot.unit.code} ${selected.abbreviation} Task Sheet`);
    return {
      project_id: projectId,
      unit_id: snapshot.unit.id,
      task_definition_id: selected.definition.id,
      task: selected.abbreviation,
      pages: document.pages,
      markdown: document.markdown,
    };
  }

  async taskState(projectId: number, task: string, state: string): Promise<unknown> {
    if (!writableTaskStates.includes(state as (typeof writableTaskStates)[number])) {
      throw new CliError("usage", `state must be one of: ${writableTaskStates.join(", ")}`);
    }
    const snapshot = await this.snapshot(projectId);
    const selected = selectedTask(snapshot, task);
    const updated = await this.client.updateTaskState(projectId, selected.definition.id, state);
    if (updated.task_definition_id !== selected.definition.id || updated.status !== state) {
      throw new CliError("upstream_contract", `OnTrack did not update task ${selected.definition.abbreviation} to ${state}`);
    }
    return {
      project_id: projectId,
      task_definition_id: selected.definition.id,
      task: selected.definition.abbreviation,
      previous_status: selected.row.status,
      status: updated.status,
    };
  }

  async prepareTaskSubmission(projectId: number, task: string, options: TaskSubmissionOptions): Promise<TaskSubmissionPlan> {
    const type = submissionType(options.type);
    const snapshot = await this.snapshot(projectId);
    const selected = selectedTask(snapshot, task);
    const uploads = await prepareUploads(options.files, selected.definition.upload_requirements, this.signal);
    return {
      projectId,
      taskDefinitionId: selected.definition.id,
      task: selected.definition.abbreviation,
      previousStatus: selected.row.status,
      type,
      acceptTiiEula: options.acceptTiiEula ?? false,
      ...(options.comment === undefined ? {} : { comment: options.comment }),
      uploads,
    };
  }

  async submitTask(plan: TaskSubmissionPlan): Promise<unknown> {
    const updated = await this.client.submitTask(
      plan.projectId,
      plan.taskDefinitionId,
      plan.uploads,
      plan.comment === undefined
        ? { type: plan.type, acceptTiiEula: plan.acceptTiiEula }
        : { type: plan.type, comment: plan.comment, acceptTiiEula: plan.acceptTiiEula },
    );
    if (updated.task_definition_id !== plan.taskDefinitionId || updated.status !== plan.type) {
      throw new CliError("upstream_contract", `OnTrack did not accept task ${plan.task} as ${plan.type}`);
    }
    return {
      project_id: plan.projectId,
      task_definition_id: plan.taskDefinitionId,
      task: plan.task,
      previous_status: plan.previousStatus,
      status: updated.status,
      submission_type: plan.type,
      processing_async: true,
    };
  }

  private async snapshot(projectId: number) {
    const project = await this.client.getProject(projectId);
    const unit = await this.client.getUnit(project.unit.id);
    return buildProjectSnapshot(
      { ...project, flexible_dates: unit.allow_flexible_dates ?? project.flexible_dates },
      unit,
      this.clock,
    );
  }

  private ambiguousProject(reference: string, projectIds: readonly number[]): CliError {
    return new CliError("usage", `Unit ${reference} matches multiple projects: ${projectIds.join(", ")}. Use a project ID.`);
  }
}
