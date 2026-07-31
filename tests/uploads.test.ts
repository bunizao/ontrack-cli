import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../src/errors.js";
import { prepareUploads } from "../src/uploads.js";
import type { UploadRequirement } from "../src/types.js";

const requirements: readonly UploadRequirement[] = [
  { key: "file0", name: "Report", type: "document", submission_history: true },
  { key: "file1", name: "Source", type: "zip", submission_history: false },
];

export async function test_uploads_are_read_once_in_requirement_order(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-uploads-"));
  const report = join(directory, "report.pdf");
  const source = join(directory, "source.zip");
  try {
    await writeFile(report, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    await writeFile(source, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

    const uploads = await prepareUploads([report, source], requirements);

    assert.deepEqual(uploads.map(({ key, requirementName, requirementType, filename, bytes }) => ({
      key,
      requirementName,
      requirementType,
      filename,
      bytes: [...bytes],
    })), [
      { key: "file0", requirementName: "Report", requirementType: "document", filename: "report.pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
      { key: "file1", requirementName: "Source", requirementType: "zip", filename: "source.zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function test_uploads_reject_count_empty_directory_and_symlink_inputs(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-invalid-uploads-"));
  const empty = join(directory, "empty.pdf");
  const nested = join(directory, "nested");
  const link = join(directory, "report.pdf");
  try {
    await writeFile(empty, new Uint8Array());
    await mkdir(nested);
    await symlink(empty, link);

    await assert.rejects(prepareUploads([empty], requirements), /requires 2 files.*received 1/iu);
    for (const path of [empty, nested, link]) {
      await assert.rejects(
        prepareUploads([path], [requirements[0]!]),
        (error) => error instanceof CliError && error.category === "usage",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
