import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const coverageDirectory = mkdtempSync(join(tmpdir(), "ontrack-domain-coverage-"));
const domainModules = new Set(["grades.js", "project-snapshot.js", "status.js", "time.js"]);
const coveredFunctions = new Map([...domainModules].map((name) => [name, { covered: 0, total: 0 }]));

try {
  const run = spawnSync(process.execPath, [".build/tests/harness.js"], {
    env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory },
    encoding: "utf8",
  });
  if (run.status !== 0) {
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    throw new Error("Tests failed while collecting domain coverage");
  }

  for (const file of readdirSync(coverageDirectory).filter((name) => name.endsWith(".json"))) {
    const report = JSON.parse(readFileSync(join(coverageDirectory, file), "utf8"));
    for (const script of report.result ?? []) {
      if (typeof script.url !== "string" || !script.url.includes("/.build/src/")) continue;
      const name = basename(new URL(script.url).pathname);
      const coverage = coveredFunctions.get(name);
      if (!coverage || coverage.total > 0) continue;
      coverage.total = script.functions.length;
      coverage.covered = script.functions.filter((fn) => fn.ranges?.[0]?.count > 0).length;
    }
  }

  for (const [name, coverage] of coveredFunctions) {
    if (coverage.total === 0) throw new Error(`No coverage data found for ${name}`);
    const percentage = (coverage.covered / coverage.total) * 100;
    if (percentage < 95) throw new Error(`${name} function coverage ${percentage.toFixed(1)}% is below 95%`);
    process.stdout.write(`${name}: ${coverage.covered}/${coverage.total} functions covered\n`);
  }
} finally {
  const expectedParent = resolve(tmpdir());
  if (dirname(resolve(coverageDirectory)) === expectedParent && basename(coverageDirectory).startsWith("ontrack-domain-coverage-")) {
    rmSync(coverageDirectory, { recursive: true, force: true });
  }
}
