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

export interface SessionState {
  current: AuthenticatedSession;
}

function selectedTask(snapshot: ProjectSnapshot, reference: string): { readonly row: TaskRow; readonly definition: TaskDefinition } {
  const normalized = reference.trim().toLowerCase();
  const byAbbreviation = snapshot.tasks.find((task) => task.abbreviation.toLowerCase() === normalized);
  const numericId = /^\d+$/u.test(normalized) ? Number(normalized) : undefined;
  const row = byAbbreviation ?? (numericId === undefined ? undefined : snapshot.tasks.find((task) => task.task_definition_id === numericId));
  const definition = row && snapshot.unit.task_definitions.find((candidate) => candidate.id === row.task_definition_id);
  if (!row || !definition) {
    throw new CliError("usage", `Task ${reference} is not in project ${snapshot.project.id}. Use the abbreviation shown by \`ontrack tasks ${snapshot.project.id}\`.`);
  }
  return { row, definition };
}

function selectedDownloadTask(
  snapshot: ProjectSnapshot,
  reference: string,
): { readonly abbreviation: string; readonly definition: TaskDefinition } {
  const normalized = reference.trim().toLowerCase();
  const numericId = /^\d+$/u.test(normalized) ? Number(normalized) : undefined;
  const assigned = snapshot.tasks.find((task) => task.abbreviation.toLowerCase() === normalized)
    ?? (numericId === undefined ? undefined : snapshot.tasks.find((task) => task.task_definition_id === numericId));
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

export class OnTrackApplication implements CliApplication {
  constructor(
    private readonly sessionState: SessionState,
    private readonly client: OnTrackClient,
    private readonly clock: Clock,
    private readonly signal?: AbortSignal,
  ) {}

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

  private async snapshot(projectId: number) {
    const project = await this.client.getProject(projectId);
    const unit = await this.client.getUnit(project.unit.id);
    return buildProjectSnapshot(
      { ...project, flexible_dates: unit.allow_flexible_dates ?? project.flexible_dates },
      unit,
      this.clock,
    );
  }
}
