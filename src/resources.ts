import { link, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import { CliError } from "./errors.js";

export type ResourceArchiveWriter = (
  path: string,
  bytes: Uint8Array,
  options: { readonly flag: "wx"; readonly signal?: AbortSignal },
) => Promise<void>;

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

export async function writeResourceArchive(
  destination: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
  writer: ResourceArchiveWriter = writeFile,
): Promise<string> {
  const archivePath = resolve(destination);
  const temporaryPath = join(dirname(archivePath), `.${basename(archivePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    if (signal?.aborted) throw new CliError("cancellation", "Resource download cancelled");
    await writer(temporaryPath, bytes, signal ? { flag: "wx", signal } : { flag: "wx" });
    if (signal?.aborted) throw new CliError("cancellation", "Resource download cancelled");
    await link(temporaryPath, archivePath);
    return archivePath;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new CliError("cancellation", "Resource download cancelled");
    }
    if (errorCode(error) === "EEXIST") {
      throw new CliError("usage", `Output file already exists: ${archivePath}`);
    }
    throw new CliError("config", `Could not write resource archive: ${archivePath}`);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
