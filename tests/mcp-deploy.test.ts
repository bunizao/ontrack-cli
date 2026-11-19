import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "../src/errors.js";
import { deployMcp, deploymentFile, mcpStatus, workerOrigin, WRANGLER, type CommandRunner } from "../src/mcp-deploy.js";

const ORIGIN = "https://ontrack-mcp.someone.workers.dev";
const OKTA = { username: "student@example.edu", password: "hunter2-password", totpSecret: "JBSWY3DPEHPK3PXP" };

interface Call { readonly args: readonly string[]; readonly stdin: string | undefined }

async function workspace(): Promise<{ dir: string; bundle: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ontrack-mcp-"));
  const bundle = join(dir, "index.js");
  await writeFile(bundle, "export default {};\n");
  return { dir, bundle, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function runner(calls: Call[], deployCode = 0): CommandRunner {
  return async (_command, args, options) => {
    calls.push({ args, stdin: options.stdin });
    if (args.includes("deploy")) return { code: deployCode, stdout: `Uploaded ontrack-mcp\nDeployed ontrack-mcp triggers\n  ${ORIGIN}\n` };
    return { code: 0, stdout: "Finished processing secrets file" };
  };
}

function worker(answer: { isError?: boolean; text: string }, seen: Request[] = []): typeof fetch {
  return async (input, init) => {
    seen.push(new Request(input, init));
    return Response.json({ jsonrpc: "2.0", id: 1, result: { isError: answer.isError ?? false, content: [{ type: "text", text: answer.text }] } });
  };
}

export async function test_mcp_deploy_uploads_the_bundle_and_sends_secrets_only_on_stdin(): Promise<void> {
  const { dir, bundle, cleanup } = await workspace();
  try {
    const calls: Call[] = [];
    const seen: Request[] = [];
    const result = await deployMcp({
      configDir: dir, baseUrl: "https://ontrack.example.edu", bundle, timeZone: "Australia/Melbourne",
      oktaCredentials: async () => OKTA, run: runner(calls), fetch: worker({ text: JSON.stringify({ username: "student" }) }, seen),
    }) as { url: string; signed_in_as: string };
    assert.equal(result.url, `${ORIGIN}/mcp`);
    assert.equal(result.signed_in_as, "student");

    assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [["--yes", WRANGLER, "deploy"], ["--yes", WRANGLER, "secret"]]);
    for (const call of calls) for (const secret of [OKTA.password, OKTA.totpSecret]) assert.ok(!call.args.join(" ").includes(secret));
    const secrets = JSON.parse(calls[1]!.stdin!) as Record<string, string>;
    assert.deepEqual(Object.keys(secrets).sort(), ["OKTA_PASSWORD", "OKTA_TOTP_SECRET", "OKTA_USERNAME", "OWNER_TOKEN"]);
    assert.equal(secrets.OKTA_PASSWORD, OKTA.password);

    const config = JSON.parse(await readFile(join(dir, "mcp", "wrangler.json"), "utf8")) as Record<string, unknown>;
    assert.equal(config.main, bundle);
    assert.equal(config.no_bundle, true);
    assert.deepEqual(config.vars, { ONTRACK_ORIGIN: "https://ontrack.example.edu", TIME_ZONE: "Australia/Melbourne" });

    const saved = JSON.parse(await readFile(deploymentFile(dir), "utf8")) as { url: string; owner_token: string };
    assert.deepEqual(saved, { url: ORIGIN, owner_token: secrets.OWNER_TOKEN });
    assert.equal((await stat(deploymentFile(dir))).mode & 0o777, 0o600);
    assert.equal(seen[0]?.headers.get("authorization"), `Bearer ${secrets.OWNER_TOKEN}`);
  } finally {
    await cleanup();
  }
}

export async function test_mcp_redeploy_keeps_the_owner_token(): Promise<void> {
  const { dir, bundle, cleanup } = await workspace();
  try {
    const tokens: string[] = [];
    for (let round = 0; round < 2; round += 1) {
      const calls: Call[] = [];
      await deployMcp({ configDir: dir, baseUrl: "https://ontrack.example.edu", bundle, oktaCredentials: async () => OKTA,
        run: runner(calls), fetch: worker({ text: "{}" }) });
      tokens.push((JSON.parse(calls[1]!.stdin!) as { OWNER_TOKEN: string }).OWNER_TOKEN);
    }
    assert.equal(tokens[0], tokens[1]);
    assert.ok(tokens[0]!.length >= 43);
  } finally {
    await cleanup();
  }
}

export async function test_mcp_deploy_stops_before_wrangler_without_okta_credentials(): Promise<void> {
  const { dir, bundle, cleanup } = await workspace();
  try {
    const calls: Call[] = [];
    await assert.rejects(deployMcp({ configDir: dir, baseUrl: "https://ontrack.example.edu", bundle, run: runner(calls),
      oktaCredentials: async () => { throw new CliError("config", "okta export did not print a username, password and TOTP secret."); } }), /okta export/u);
    assert.equal(calls.length, 0);
  } finally {
    await cleanup();
  }
}

export async function test_mcp_deploy_reports_a_worker_that_cannot_sign_in(): Promise<void> {
  const { dir, bundle, cleanup } = await workspace();
  try {
    await assert.rejects(deployMcp({ configDir: dir, baseUrl: "https://ontrack.example.edu", bundle, oktaCredentials: async () => OKTA,
      run: runner([]), fetch: worker({ isError: true, text: "Okta sign-in is blocked (credentials_rejected)." }) }),
    (error: unknown) => error instanceof CliError && error.category === "auth" && /blocked/u.test(error.message));
  } finally {
    await cleanup();
  }
}

export async function test_mcp_status_reads_the_worker_with_the_owner_token(): Promise<void> {
  const { dir, cleanup } = await workspace();
  try {
    await assert.rejects(mcpStatus({ configDir: dir }), (error: unknown) => error instanceof CliError && /mcp deploy/u.test(error.hint ?? ""));
    await writeFile(deploymentFile(dir), JSON.stringify({ url: ORIGIN, owner_token: "owner" }));
    const seen: Request[] = [];
    const status = await mcpStatus({ configDir: dir, fetch: async (input, init) => {
      seen.push(new Request(input, init));
      return Response.json({ version: "0.5.0", session: { username: "student" } });
    } });
    assert.deepEqual(status, { url: `${ORIGIN}/mcp`, version: "0.5.0", session: { username: "student" } });
    assert.equal(seen[0]?.url, `${ORIGIN}/status`);
    assert.equal(seen[0]?.headers.get("authorization"), "Bearer owner");
  } finally {
    await cleanup();
  }
}

export async function test_mcp_deploy_pins_the_wrangler_that_built_the_bundle(): Promise<void> {
  const metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { devDependencies: Record<string, string> };
  assert.equal(WRANGLER, `wrangler@${metadata.devDependencies.wrangler}`);
}

export function test_worker_origin_takes_only_this_workers_url(): void {
  assert.equal(workerOrigin(`see https://other.someone.workers.dev\n  ${ORIGIN}\n`), ORIGIN);
  assert.equal(workerOrigin("no url here"), null);
}
