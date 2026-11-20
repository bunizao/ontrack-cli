import { OnTrackService, placeholderFile, selectedDownloadTask, selectedTask, taskSheetTask, type SessionState } from "./application-core.js";
import type { CliApplication } from "./cli-app.js";
import type { OnTrackClient } from "./ontrack.js";
import { assertOutputAvailable, writeDownloadedFile, writeResourceArchive } from "./resources.js";
import { CliError } from "./errors.js";
import type { Clock } from "./time.js";
import { pdfToMarkdown } from "./pdf.js";
import { submissionType, type TaskSubmissionOptions, type TaskSubmissionPlan } from "./submission.js";
import { prepareUploads } from "./uploads.js";

export type { SessionState } from "./application-core.js";

// The CLI's application: the shared service plus what needs a file system.
export class OnTrackApplication extends OnTrackService implements CliApplication {
  constructor(
    sessionState: SessionState,
    client: OnTrackClient,
    clock: Clock,
    private readonly signal?: AbortSignal,
  ) {
    super(sessionState, client, clock);
  }

  async resourcesDownload(projectId: number, options: { readonly output?: string; readonly force?: boolean }): Promise<unknown> {
    const destination = options.output ?? `ontrack-resources-${projectId}.zip`;
    if (!options.force) await assertOutputAvailable(destination);
    const archive = await this.client.downloadProjectResources(projectId);
    const archivePath = await writeResourceArchive(
      destination,
      archive.bytes,
      this.signal,
      undefined,
      options.force,
    );
    return {
      project_id: archive.projectId,
      unit_id: archive.unitId,
      archive_path: archivePath,
      bytes_written: archive.bytes.length,
    };
  }

  async taskSheetDownload(projectId: number, task: string, options: { readonly output?: string; readonly force?: boolean }): Promise<unknown> {
    const { snapshot, selected, download, destination } = await this.validatedTaskSheet(projectId, task, options);
    const filePath = await writeDownloadedFile(destination, download.bytes, this.signal, undefined, options.force);
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

  async taskResourcesDownload(projectId: number, task: string, options: { readonly output?: string; readonly force?: boolean }): Promise<unknown> {
    const snapshot = await this.snapshot(projectId);
    const selected = selectedDownloadTask(snapshot, task);
    if (selected.definition.has_task_resources === false) {
      throw new CliError("upstream_api", `Task ${selected.abbreviation} has no resources.`);
    }
    if (options.output && !options.force) await assertOutputAvailable(options.output);
    const download = await this.client.downloadTaskResources(snapshot.unit.id, selected.definition.id);
    if (placeholderFile(download.filename)) throw new CliError("upstream_api", `Task ${selected.abbreviation} has no resources.`);
    if (!download.filename && !options.output) {
      throw new CliError("upstream_contract", "OnTrack returned task resources without a filename");
    }
    const destination = options.output ?? download.filename as string;
    if (!options.output && !options.force) await assertOutputAvailable(destination);
    const filePath = await writeDownloadedFile(destination, download.bytes, this.signal, undefined, options.force);
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
    const { snapshot, selected, download } = await this.validatedTaskSheet(projectId, task);
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

  private async validatedTaskSheet(
    projectId: number,
    task: string,
    options?: { readonly output?: string; readonly force?: boolean },
  ) {
    const snapshot = await this.snapshot(projectId);
    const selected = taskSheetTask(snapshot, task);
    const destination = options?.output ?? `${snapshot.unit.code}-${selected.abbreviation}.pdf`;
    if (options && !options.force) await assertOutputAvailable(destination);
    const download = await this.downloadTaskSheet(snapshot, selected);
    return { snapshot, selected, download, destination };
  }

}
