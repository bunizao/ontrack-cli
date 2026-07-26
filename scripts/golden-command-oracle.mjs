import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const provenance = JSON.parse(await readFile(new URL("../tests/golden/oracle-provenance.json", import.meta.url), "utf8"));
export const oracleCommit = provenance.python_release_commit;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function isSafeRelativePath(value) {
  return typeof value === "string"
    && /^[a-z][a-z-]*\/[a-z0-9][a-z0-9-]*$/u.test(value);
}

export function isSafeArtifactPath(value) {
  return typeof value === "string"
    && /^commands\/[a-z][a-z-]*\/[a-z0-9][a-z0-9-]*\.json$/u.test(value);
}

function validateIdentity(key, value) {
  const substitutions = {
    username: "recorded-user",
    first_name: "Recorded",
    last_name: "User",
    email: "recorded-user@example.invalid",
    nickname: "Recorded",
    base_url: "https://school.example.invalid",
  };
  if (!(key in substitutions) || value === null) return;
  if (value !== substitutions[key]) throw new Error(`Python stdout contains forbidden identity field ${key}`);
}

function validateValue(value, key = "") {
  if (Array.isArray(value)) {
    for (const item of value) validateValue(item, key);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      if (/(?:token|cookie|password|secret|authorization)/iu.test(childKey)) {
        throw new Error(`Python stdout contains forbidden credential field ${childKey}`);
      }
      validateIdentity(childKey, child);
      validateValue(child, childKey);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (/ontrack\.infotech\.monash\.edu|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}/iu.test(value)) {
    throw new Error(`Python stdout contains a forbidden value in ${key || "output"}`);
  }
  if (value.includes("@") && !/@example\.invalid$/iu.test(value)) {
    throw new Error(`Python stdout contains forbidden identity text in ${key || "output"}`);
  }
}

export function validateSanitizedJsonStdout(stdout) {
  if (!stdout.endsWith("\n")) throw new Error("Python stdout must end with one newline");
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Python stdout must contain only valid JSON");
  }
  if (value === null || typeof value !== "object") throw new Error("Python stdout JSON must be an object or array");
  validateValue(value);
  return value;
}

export function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
