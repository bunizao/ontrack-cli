import process from "node:process";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(`${process.cwd()}/.build/tests/golden.test.js`).href;
const suite = await import(moduleUrl);
let failures = 0;

for (const [name, candidate] of Object.entries(suite).sort(([left], [right]) => left.localeCompare(right))) {
  if (!name.startsWith("test_") || typeof candidate !== "function") continue;
  try {
    await candidate();
    process.stdout.write(`ok golden.test.ts ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`not ok golden.test.ts ${name}\n`);
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  }
}

process.exitCode = failures === 0 ? 0 : 1;
