import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const root = join(process.cwd(), "tests", "golden");
const requiredCaseFiles = ["argv", "env", "exit", "source.json", "stderr.txt", "stdout.json"];
const forbidden = [
  "ontrack.infotech.monash.edu",
  "auth-token",
  "refresh_token",
  "access_token",
  "authentication_token",
  "cookie",
  ...(process.env.GOLDEN_FORBIDDEN_VALUES ?? "").split(",").map((value) => value.trim()).filter(Boolean),
];
const credentialPattern = /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/u;
const authorizationPattern = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}/iu;
let failures = 0;

async function directories(path) {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function scan(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await scan(child);
      continue;
    }
    if (entry.name === "README.md") continue;
    const contents = await readFile(child, "utf8");
    const normalized = contents.toLowerCase();
    for (const value of forbidden) {
      if (!normalized.includes(value.toLowerCase())) continue;
      failures += 1;
      process.stderr.write(`${child}: contains forbidden value ${value}\n`);
    }
    if (credentialPattern.test(contents)) {
      failures += 1;
      process.stderr.write(`${child}: contains a credential-shaped value\n`);
    }
    if (authorizationPattern.test(contents)) {
      failures += 1;
      process.stderr.write(`${child}: contains an authorization-shaped value\n`);
    }
  }
}

for (const command of await directories(root)) {
  if (command === "sources") continue;
  for (const caseName of await directories(join(root, command))) {
    const directory = join(root, command, caseName);
    const actual = (await readdir(directory)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(requiredCaseFiles)) {
      failures += 1;
      process.stderr.write(`${directory}: expected exactly ${requiredCaseFiles.join(", ")}\n`);
    }
  }
}

await scan(root);
if (failures === 0) process.stdout.write("Golden corpus structure and secret scan passed.\n");
process.exitCode = failures === 0 ? 0 : 1;
