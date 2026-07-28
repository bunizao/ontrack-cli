import { CliError } from "./errors.js";
import { HttpClient } from "./http.js";
import { readProject, readProjects, readRoles, readUnit } from "./readers.js";
import type { Project, ProjectSummary, Unit, UnitRole } from "./types.js";

export interface ProjectResourcesArchive {
  readonly projectId: number;
  readonly unitId: number;
  readonly bytes: Uint8Array;
}

function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  return (bytes[2] === 0x03 && bytes[3] === 0x04)
    || (bytes[2] === 0x05 && bytes[3] === 0x06)
    || (bytes[2] === 0x07 && bytes[3] === 0x08);
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
          `Project ${id} is not accessible. Run \`ontrack projects --include-inactive\` to find your project IDs.`,
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
    const bytes = await this.http.download(`api/units/${project.unit.id}/all_resources`);
    if (!isZip(bytes)) {
      throw new CliError("upstream_contract", "OnTrack returned an invalid resource archive");
    }
    return { projectId, unitId: project.unit.id, bytes };
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
