import { CliError } from "./errors.js";
import type { PreparedUpload } from "./uploads.js";

export const submissionTypes = ["ready_for_feedback", "need_help", "assess_in_portfolio"] as const;
export type SubmissionType = (typeof submissionTypes)[number];

export interface TaskSubmissionOptions {
  readonly files: readonly string[];
  readonly type: string;
  readonly comment?: string;
  readonly acceptTiiEula?: boolean;
}

export interface TaskSubmissionPlan {
  readonly projectId: number;
  readonly taskDefinitionId: number;
  readonly task: string;
  readonly previousStatus: string;
  readonly type: SubmissionType;
  readonly comment?: string;
  readonly acceptTiiEula: boolean;
  readonly uploads: readonly PreparedUpload[];
}

export function submissionType(value: string): SubmissionType {
  if (!submissionTypes.includes(value as SubmissionType)) {
    throw new CliError("usage", `submission type must be one of: ${submissionTypes.join(", ")}`);
  }
  return value as SubmissionType;
}
