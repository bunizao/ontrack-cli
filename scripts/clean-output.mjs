import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const repository = process.cwd();

for (const name of ["dist", ".build"]) {
  const output = resolve(repository, name);
  if (basename(output) !== name || dirname(output) !== repository) {
    throw new Error(`Refusing to clean an unexpected output path: ${output}`);
  }

  rmSync(output, { recursive: true, force: true });
}

mkdirSync(resolve(repository, "dist"));
