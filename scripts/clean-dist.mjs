import { mkdirSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const repository = process.cwd();
const distribution = resolve(repository, "dist");

if (basename(distribution) !== "dist" || dirname(distribution) !== repository) {
  throw new Error("Refusing to clean an unexpected distribution path");
}

rmSync(distribution, { recursive: true, force: true });
mkdirSync(distribution);
