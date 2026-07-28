import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../src/errors.js";
import { writeResourceArchive } from "../src/resources.js";

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
