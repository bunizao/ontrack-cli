import { link, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import { CliError } from "./errors.js";

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

export async function writeResourceArchive(destination: string, bytes: Uint8Array): Promise<string> {
  const archivePath = resolve(destination);
  const temporaryPath = join(dirname(archivePath), `.${basename(archivePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await link(temporaryPath, archivePath);
    return archivePath;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new CliError("usage", `Output file already exists: ${archivePath}`);
    }
    throw new CliError("config", `Could not write resource archive: ${archivePath}`);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
