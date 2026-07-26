import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const failures = [];
for (const path of files("src")) {
  const source = readFileSync(path, "utf8");
  if (/\b(?:TODO|FIXME|unimplemented)\b/i.test(source)) failures.push(`${path}: unfinished marker`);
}
for (const path of files("tests-ts").filter((value) => value.endsWith(".ts"))) {
  const source = readFileSync(path, "utf8");
  if (/\b(?:skip|pending)\s*\(/.test(source)) failures.push(`${path}: skipped or pending test`);
}
for (const path of files("tests-ts/fixtures")) {
  const fixture = readFileSync(path, "utf8");
  if (/ontrack\.infotech\.monash\.edu|Auth-Token|authentication_token|access_token|refresh_token/i.test(fixture)) {
    failures.push(`${path}: deployment or credential data`);
  }
}

const tracked = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
if (tracked.status !== 0) throw new Error(tracked.stderr || "Could not enumerate tracked files");
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:gh[opusr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/u,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)?\b/u,
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}/iu,
];
for (const path of tracked.stdout.split("\0").filter(Boolean)) {
  if (!existsSync(path)) continue;
  const source = readFileSync(path);
  if (source.includes(0)) continue;
  const text = source.toString("utf8");
  if (credentialPatterns.some((pattern) => pattern.test(text))) failures.push(`${path}: credential-shaped value`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
}
