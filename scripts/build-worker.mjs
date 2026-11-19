// Bundles the remote MCP Worker (src/worker) into dist/worker/index.js, which
// `ontrack mcp deploy` uploads as-is. Runs after `npm run build`, which empties dist.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outdir = join(root, "dist", "worker");
const scratch = mkdtempSync(join(tmpdir(), "ontrack-worker-"));
const config = join(scratch, "wrangler.json");
// Bundling only: the bindings and vars `ontrack mcp deploy` writes do not change the bundle.
writeFileSync(config, JSON.stringify({
  name: "ontrack-mcp",
  main: join(root, "src", "worker", "index.ts"),
  compatibility_date: "2026-08-09",
}));
try {
  // Run wrangler's JS entry with this Node: node_modules/.bin/wrangler is a shell script on Windows.
  const result = spawnSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
    "deploy", "--dry-run", "--config", config, "--outdir", outdir], { stdio: ["ignore", "ignore", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  for (const extra of ["index.js.map", "README.md"]) rmSync(join(outdir, extra), { force: true });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
