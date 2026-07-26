export const errorCategories = [
  "usage",
  "config",
  "auth",
  "upstream_contract",
  "upstream_api",
  "network",
  "cancellation",
] as const;

export type ErrorCategory = (typeof errorCategories)[number];

export class CliError extends Error {
  readonly category: ErrorCategory;
  readonly statusCode: number | undefined;

  constructor(category: ErrorCategory, message: string, statusCode?: number) {
    super(message);
    this.name = "CliError";
    this.category = category;
    this.statusCode = statusCode;
  }
}

export function exitCodeFor(category: ErrorCategory): number {
  switch (category) {
    case "usage": return 2;
    case "cancellation": return 130;
    case "config":
    case "auth":
    case "upstream_contract":
    case "upstream_api":
    case "network": return 1;
  }
}
