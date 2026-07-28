import assert from "node:assert/strict";

import { assertSupportedRuntime, nodeSqliteRelaunchArgs } from "../src/runtime.js";

export function test_node_22_relaunches_with_sqlite_enabled(): void {
  assert.deepEqual(nodeSqliteRelaunchArgs({
    nodeVersion: "22.12.0",
    bunVersion: undefined,
    execArgv: ["--inspect=0"],
    argv: ["/usr/bin/node", "/opt/ontrack/dist/cli.js", "auth", "login"],
  }), [
    "--experimental-sqlite",
    "--disable-warning=ExperimentalWarning",
    "--inspect=0",
    "/opt/ontrack/dist/cli.js",
    "auth",
    "login",
  ]);
}

export function test_sqlite_relaunch_is_skipped_for_supported_or_already_configured_runtimes(): void {
  const argv = ["/usr/bin/node", "/opt/ontrack/dist/cli.js", "auth", "login"];
  assert.equal(nodeSqliteRelaunchArgs({
    nodeVersion: "22.12.0",
    bunVersion: "1.3.14",
    execArgv: [],
    argv,
  }), undefined);
  assert.equal(nodeSqliteRelaunchArgs({
    nodeVersion: "22.12.0",
    bunVersion: undefined,
    execArgv: ["--experimental-sqlite"],
    argv,
  }), undefined);
  assert.equal(nodeSqliteRelaunchArgs({
    nodeVersion: "22.13.0",
    bunVersion: undefined,
    execArgv: [],
    argv,
  }), undefined);
  assert.ok(nodeSqliteRelaunchArgs({
    nodeVersion: "23.3.0",
    bunVersion: undefined,
    execArgv: [],
    argv,
  }));
  assert.equal(nodeSqliteRelaunchArgs({
    nodeVersion: "23.4.0",
    bunVersion: undefined,
    execArgv: [],
    argv,
  }), undefined);
  assert.equal(nodeSqliteRelaunchArgs({
    nodeVersion: "24.0.0",
    bunVersion: undefined,
    execArgv: [],
    argv,
  }), undefined);
  assert.equal(nodeSqliteRelaunchArgs({
    nodeVersion: "22.12.0",
    bunVersion: undefined,
    execArgv: [],
    argv,
    nodeOptions: "--experimental-sqlite",
  }), undefined);
}

export function test_runtime_gate_rejects_old_node_but_allows_bun(): void {
  assert.throws(() => assertSupportedRuntime("18.14.0"), /Node\.js 18\.14\.0.*22\.5/u);
  assert.doesNotThrow(() => assertSupportedRuntime("22.5.0"));
  assert.doesNotThrow(() => assertSupportedRuntime("18.14.0", "1.3.0"));
}
