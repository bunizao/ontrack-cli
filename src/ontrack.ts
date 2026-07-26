import { CliError } from "./errors.js";
import { HttpClient } from "./http.js";
import { readProject, readProjects, readRoles, readUnit } from "./readers.js";
import type { Project, ProjectSummary, Unit, UnitRole } from "./types.js";

export interface AuthMethod {
  readonly method: string;
  readonly redirect_to?: string | null;
}

export class OnTrackClient {
  constructor(readonly http: HttpClient) {}

  async getProjects(includeInactive = false): Promise<ProjectSummary[]> {
    return readProjects(await this.http.request("api/projects", {
      query: { include_inactive: includeInactive },
    }));
  }

  async getProject(id: number): Promise<Project> {
    return readProject(await this.http.request(`api/projects/${id}`));
  }

  async getUnit(id: number): Promise<Unit> {
    return readUnit(await this.http.request(`api/units/${id}`));
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
