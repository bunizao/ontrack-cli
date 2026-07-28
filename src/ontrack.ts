import { CliError } from "./errors.js";
import { HttpClient, type DownloadResponse } from "./http.js";
import { readProject, readProjects, readRoles, readTaskComments, readTaskUpdate, readUnit } from "./readers.js";
import type { Project, ProjectSummary, TaskComment, TaskUpdate, Unit, UnitRole } from "./types.js";

export interface ProjectResourcesArchive {
  readonly projectId: number;
  readonly unitId: number;
  readonly bytes: Uint8Array;
}

function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 22) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstPossibleOffset = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= firstPossibleOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength !== bytes.length) continue;
    const disk = view.getUint16(offset + 4, true);
    const centralDisk = view.getUint16(offset + 6, true);
    const diskEntries = view.getUint16(offset + 8, true);
    const entries = view.getUint16(offset + 10, true);
    const centralSize = view.getUint32(offset + 12, true);
    const centralOffset = view.getUint32(offset + 16, true);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries || centralOffset + centralSize !== offset) return false;
    if (entries === 0) return centralSize === 0;
    let cursor = centralOffset;
    for (let entry = 0; entry < entries; entry += 1) {
      if (cursor + 46 > offset || view.getUint32(cursor, true) !== 0x02014b50) return false;
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const entryCommentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) return false;
      cursor += 46 + nameLength + extraLength + entryCommentLength;
    }
    return cursor === offset;
  }
  return false;
}

export interface AuthMethod {
  readonly method: string;
  readonly redirect_to?: string | null;
}

export class OnTrackClient {
  constructor(private readonly http: HttpClient) {}

  async getProjects(includeInactive = false): Promise<ProjectSummary[]> {
    return readProjects(await this.http.request("api/projects", {
      query: { include_inactive: includeInactive },
    }));
  }

  async getProject(id: number): Promise<Project> {
    try {
      return readProject(await this.http.request(`api/projects/${id}`));
    } catch (error) {
      if (error instanceof CliError && error.statusCode === 403) {
        throw new CliError(
          "upstream_api",
          `Project ${id} is not accessible. Project arguments use the id from \`ontrack projects --include-inactive\`, not list positions.`,
          403,
        );
      }
      throw error;
    }
  }

  async getUnit(id: number): Promise<Unit> {
    return readUnit(await this.http.request(`api/units/${id}`));
  }

  async downloadProjectResources(projectId: number): Promise<ProjectResourcesArchive> {
    const project = await this.getProject(projectId);
    let bytes: Uint8Array;
    try {
      bytes = await this.http.download(`api/units/${project.unit.id}/all_resources`);
    } catch (error) {
      if (error instanceof CliError && error.statusCode === 401) {
        throw new CliError("upstream_api", `Resources for project ${projectId} are not accessible`, 401);
      }
      throw error;
    }
    if (!isZip(bytes)) {
      throw new CliError("upstream_contract", "OnTrack returned an invalid resource archive");
    }
    return { projectId, unitId: project.unit.id, bytes };
  }

  async downloadTaskSheet(unitId: number, taskDefinitionId: number): Promise<DownloadResponse> {
    return this.http.downloadFile(`api/units/${unitId}/task_definitions/${taskDefinitionId}/task_pdf`, {
      query: { as_attachment: true },
    });
  }

  async downloadTaskResources(unitId: number, taskDefinitionId: number): Promise<DownloadResponse> {
    return this.http.downloadFile(`api/units/${unitId}/task_definitions/${taskDefinitionId}/task_resources`);
  }

  async getTaskComments(projectId: number, taskDefinitionId: number): Promise<TaskComment[]> {
    return readTaskComments(await this.http.request(
      `api/projects/${projectId}/task_def_id/${taskDefinitionId}/comments`,
    ));
  }

  async updateTaskState(projectId: number, taskDefinitionId: number, state: string): Promise<TaskUpdate> {
    return readTaskUpdate(await this.http.request(
      `api/projects/${projectId}/task_def_id/${taskDefinitionId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: state }),
      },
    ));
  }

  async getRoles(activeOnly = true): Promise<UnitRole[]> {
    return readRoles(await this.http.request("api/unit_roles", {
      query: { active_only: activeOnly },
    }));
  }

  async getAuthMethod(): Promise<AuthMethod> {
    const value = await this.http.request("api/auth/method");
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CliError("upstream_contract", "auth method must be an object");
    }
    const method = Reflect.get(value, "method");
    const redirectTo = Reflect.get(value, "redirect_to");
    if (typeof method !== "string" || (redirectTo !== undefined && redirectTo !== null && typeof redirectTo !== "string")) {
      throw new CliError("upstream_contract", "auth method response is invalid");
    }
    return redirectTo === undefined ? { method } : { method, redirect_to: redirectTo };
  }
}
