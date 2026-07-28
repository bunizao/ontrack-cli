import type { AuthenticatedSession } from "./auth.js";
import type { CliApplication } from "./cli-app.js";
import type { OnTrackClient } from "./ontrack.js";
import { buildProjectSnapshot } from "./project-snapshot.js";
import { projectSummaryToJson, roleToJson, snapshotToJson, userToJson } from "./serialize.js";
import { writeResourceArchive } from "./resources.js";
import type { Clock } from "./time.js";

export interface SessionState {
  current: AuthenticatedSession;
}

export class OnTrackApplication implements CliApplication {
  constructor(
    private readonly sessionState: SessionState,
    private readonly client: OnTrackClient,
    private readonly clock: Clock,
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

  async roles(options: { readonly showAll: boolean }): Promise<unknown> {
    return (await this.client.getRoles(!options.showAll)).map(roleToJson);
  }

  async resourcesDownload(projectId: number, options: { readonly output?: string }): Promise<unknown> {
    const archive = await this.client.downloadProjectResources(projectId);
    const archivePath = await writeResourceArchive(
      options.output ?? `ontrack-resources-${projectId}.zip`,
      archive.bytes,
    );
    return {
      project_id: archive.projectId,
      unit_id: archive.unitId,
      archive_path: archivePath,
      bytes_written: archive.bytes.length,
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
