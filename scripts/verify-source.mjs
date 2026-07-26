import { readFileSync, readdirSync } from "node:fs";
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

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
}
