import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type TestCase = () => void | Promise<void>;

async function main(): Promise<void> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".test.js"))
    .sort();
  let failures = 0;
  let total = 0;

  for (const file of files) {
    const module = (await import(pathToFileURL(join(directory, file)).href)) as Record<string, unknown>;
    for (const [name, candidate] of Object.entries(module).sort(([left], [right]) => left.localeCompare(right))) {
      if (!name.startsWith("test_") || typeof candidate !== "function") continue;
      total += 1;
      try {
        await (candidate as TestCase)();
        process.stdout.write(`ok ${basename(file)} ${name}\n`);
      } catch (error) {
        failures += 1;
        process.stderr.write(`not ok ${basename(file)} ${name}\n`);
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      }
    }
  }

  process.stdout.write(`${total - failures}/${total} passed\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
