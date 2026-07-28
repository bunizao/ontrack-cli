import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../src/errors.js";
import { writeResourceArchive, type ResourceArchiveWriter } from "../src/resources.js";

export async function test_cancelled_resource_write_leaves_no_archive_or_temporary_file(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-cancelled-resource-"));
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      writeResourceArchive(join(directory, "resources.zip"), new Uint8Array(1024), controller.signal),
      (error) => error instanceof CliError && error.category === "cancellation",
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function test_cancellation_during_resource_write_removes_a_partial_temporary_file(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-partial-resource-"));
  const controller = new AbortController();
  const writer: ResourceArchiveWriter = async (path, bytes) => {
    await writeFile(path, bytes.subarray(0, 1), { flag: "wx" });
    controller.abort();
    const error = new Error("cancelled");
    error.name = "AbortError";
    throw error;
  };
  try {
    await assert.rejects(
      writeResourceArchive(join(directory, "resources.zip"), new Uint8Array(1024), controller.signal, writer),
      (error) => error instanceof CliError && error.category === "cancellation",
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function test_forced_resource_write_replaces_an_existing_file_atomically(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-forced-resource-"));
  const destination = join(directory, "resources.zip");
  try {
    await writeFile(destination, new Uint8Array([1]));
    await writeResourceArchive(destination, new Uint8Array([2, 3]), undefined, undefined, true);
    assert.deepEqual([...await readFile(destination)], [2, 3]);
    assert.deepEqual(await readdir(directory), ["resources.zip"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
