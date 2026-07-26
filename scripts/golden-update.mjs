import { spawnSync } from "node:child_process";
import process from "node:process";

const result = spawnSync(process.execPath, ["scripts/golden-run.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, UPDATE_GOLDEN: "1" },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
