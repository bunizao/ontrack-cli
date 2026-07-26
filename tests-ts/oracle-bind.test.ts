import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const binder = join(process.cwd(), "scripts", "golden-bind-oracle-source.mjs");
const oracleCommit = (JSON.parse(await readFile(join(process.cwd(), "tests", "golden", "oracle-provenance.json"), "utf8")) as { readonly python_release_commit: string }).python_release_commit;

export async function test_oracle_source_binding_prepares_live_typescript_goldens_mechanically(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-oracle-bind-"));
  const sourceDirectory = join(directory, "tests", "golden", "sources", "oracle-test");
  const caseDirectory = join(directory, "tests", "golden", "projects", "current-json");
  try {
    await Promise.all([mkdir(sourceDirectory, { recursive: true }), mkdir(caseDirectory, { recursive: true })]);
    await Promise.all([
      writeFile(join(directory, "tests", "golden", "oracle-required-cases.json"), "{\"projects/current-json\":[\"projects\",\"--json\"]}\n", "utf8"),
      writeFile(join(sourceDirectory, "source.json"), `${JSON.stringify({
        schema: 1,
        kind: "python_oracle",
        live_recorded: true,
        oracle_commit: oracleCommit,
      })}\n`, "utf8"),
      writeFile(join(caseDirectory, "source.json"), "{\"id\":\"synthetic-minimal\"}\n", "utf8"),
    ]);

    const result = spawnSync(process.execPath, [binder, "oracle-test", "--confirm-bind-live-oracle"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(caseDirectory, "source.json"), "utf8")), { id: "oracle-test" });
    assert.match(result.stdout, /Run npm run test:golden:update next/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
