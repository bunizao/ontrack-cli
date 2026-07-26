import type { UserView } from "./types.js";

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function safeUserView(data: Readonly<Record<string, unknown>>, username?: string): UserView {
  return {
    id: typeof data.id === "number" && Number.isFinite(data.id) ? data.id : null,
    username: username ?? optionalString(data.username),
    first_name: optionalString(data.first_name ?? data.firstName),
    last_name: optionalString(data.last_name ?? data.lastName),
    email: optionalString(data.email),
    nickname: optionalString(data.nickname),
  };
}
