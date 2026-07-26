import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { OnTrackApplication } from "../src/application.js";
import type { AuthenticatedSession } from "../src/auth.js";
import { executeCli, type CliApplication, type CliExecution } from "../src/cli-app.js";
import { CliError } from "../src/errors.js";
import type { HttpClient, HttpRequestOptions } from "../src/http.js";
import { OnTrackClient } from "../src/ontrack.js";
import { createClock } from "../src/time.js";

const root = join(process.cwd(), "tests", "golden");
const sourcesRoot = join(root, "sources");
const secretSentinel = "ontrack-golden-secret-9d634c";
const pythonOracleCommit = "06e0c4b6d45cdda4e999e4c829d61bfe8392ef8c";

interface GoldenCase {
  readonly name: string;
  readonly directory: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly sourceId: string;
}

interface SourceMetadata {
  readonly schema: 1;
  readonly kind: "synthetic" | "python_oracle";
  readonly live_recorded: boolean;
  readonly description: string;
  readonly fixture: string;
  readonly session: string;
  readonly oracle_commit?: string;
  readonly recorded_at?: string;
  readonly capture_sha256?: string;
}

interface HttpRecord {
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly params: Readonly<Record<string, unknown>>;
  };
  readonly response: {
    readonly status_code: number;
    readonly json: unknown;
  };
}

interface SessionFixture {
  readonly base_url: string;
  readonly username: string;
  readonly user?: AuthenticatedSession["user"];
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function directories(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function goldenCases(): Promise<GoldenCase[]> {
  const cases: GoldenCase[] = [];
  for (const command of await directories(root)) {
    if (command === "sources") continue;
    for (const caseName of await directories(join(root, command))) {
      const directory = join(root, command, caseName);
      const source = await jsonFile<{ readonly id: string }>(join(directory, "source.json"));
      cases.push({
        name: `${command}/${caseName}`,
        directory,
        argv: await jsonFile<readonly string[]>(join(directory, "argv")),
        env: await jsonFile<Readonly<Record<string, string>>>(join(directory, "env")),
        sourceId: source.id,
      });
    }
  }
  return cases;
}

function normalizedPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function sameParams(left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function applicationFor(testCase: GoldenCase): Promise<CliApplication> {
  const sourceDirectory = join(sourcesRoot, testCase.sourceId);
  const metadata = await jsonFile<SourceMetadata>(join(sourceDirectory, "source.json"));
  const records = await jsonFile<readonly HttpRecord[]>(join(sourceDirectory, metadata.fixture));
  const fixture = await jsonFile<SessionFixture>(join(sourceDirectory, metadata.session));
  const http = {
    request: async (path: string, options: HttpRequestOptions = {}): Promise<unknown> => {
      const method = options.method ?? "GET";
      const params = options.query ?? {};
      const record = records.find((candidate) =>
        candidate.request.method === method
        && normalizedPath(candidate.request.path) === normalizedPath(path)
        && sameParams(candidate.request.params, params));
      if (!record) throw new CliError("upstream_contract", `No fixture for ${method} ${normalizedPath(path)}`);
      if (record.response.status_code === 401 || record.response.status_code === 419) {
        throw new CliError("auth", "OnTrack rejected the authenticated session", record.response.status_code);
      }
      if (record.response.status_code < 200 || record.response.status_code >= 300) {
        throw new CliError("upstream_api", `OnTrack returned HTTP ${record.response.status_code}`, record.response.status_code);
      }
      return record.response.json;
    },
  } as HttpClient;
  const session: AuthenticatedSession = {
    baseUrl: fixture.base_url,
    username: fixture.username,
    accessToken: secretSentinel,
    authTokenExpiry: null,
    provenance: "environment",
    user: fixture.user ?? null,
  };
  return new OnTrackApplication({ current: session }, new OnTrackClient(http), createClock(testCase.env.ONTRACK_NOW));
}

async function execute(testCase: GoldenCase): Promise<CliExecution> {
  return executeCli(testCase.argv, {
    app: await applicationFor(testCase),
    version: "0.2.0",
    sensitiveValues: [secretSentinel],
  });
}

async function expected(testCase: GoldenCase): Promise<CliExecution> {
  return {
    stdout: await readFile(join(testCase.directory, "stdout.json"), "utf8"),
    stderr: await readFile(join(testCase.directory, "stderr.txt"), "utf8"),
    exitCode: Number((await readFile(join(testCase.directory, "exit"), "utf8")).trim()),
  };
}

async function update(testCase: GoldenCase, result: CliExecution): Promise<void> {
  const metadata = await jsonFile<SourceMetadata>(join(sourcesRoot, testCase.sourceId, "source.json"));
  if (metadata.kind === "python_oracle") throw new Error(`${testCase.name} is oracle-backed and cannot be regenerated by TypeScript`);
  await Promise.all([
    writeFile(join(testCase.directory, "stdout.json"), result.stdout, "utf8"),
    writeFile(join(testCase.directory, "stderr.txt"), result.stderr, "utf8"),
    writeFile(join(testCase.directory, "exit"), `${result.exitCode}\n`, "utf8"),
  ]);
}

function commandName(argv: readonly string[]): string {
  return argv[0] === "auth" && argv[1] === "check" ? "auth check" : argv[0] ?? "";
}

export async function test_command_goldens_match_or_regenerate_mechanically(): Promise<void> {
  const cases = await goldenCases();
  assert.equal(cases.length, 18, "the cutover corpus should retain the ADR-sized 18-case matrix");
  for (const testCase of cases) {
    const result = await execute(testCase);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secretSentinel), testCase.name);
    const isExpectedFailure = testCase.name.endsWith("/invalid-id") || testCase.name.endsWith("/yaml-rejected");
    assert.equal(result.exitCode === 0, !isExpectedFailure, `${testCase.name} has the wrong success category`);
    if (process.env.UPDATE_GOLDEN === "1") await update(testCase, result);
    assert.deepEqual(result, await expected(testCase), testCase.name);
    if (testCase.argv.includes("--json") && result.exitCode === 0) {
      assert.doesNotThrow(() => JSON.parse(result.stdout), `${testCase.name} stdout must be JSON`);
      assert.equal(result.stderr, "", testCase.name);
    }
    if (result.exitCode !== 0) assert.equal(result.stdout, "", testCase.name);
  }
}

export async function test_every_parser_command_has_a_golden_case(): Promise<void> {
  const cases = await goldenCases();
  const help = await executeCli(["--help"], {
    app: await applicationFor(cases[0]!),
    version: "0.2.0",
  });
  const parserCommands = [...help.stdout.matchAll(/^  (auth check|[a-z][a-z-]*)(?:\s+<[^>]+>)?\s+/gmu)]
    .map((match) => match[1]!)
    .sort();
  const covered = new Set(cases.map((testCase) => commandName(testCase.argv)));
  assert.deepEqual(parserCommands, [...covered].sort());
}

export async function test_source_metadata_never_confuses_synthetic_with_live_oracle_data(): Promise<void> {
  for (const sourceId of await directories(sourcesRoot)) {
    const metadata = await jsonFile<SourceMetadata>(join(sourcesRoot, sourceId, "source.json"));
    assert.equal(metadata.schema, 1, sourceId);
    assert.ok(metadata.description.trim(), sourceId);
    assert.ok(metadata.kind === "synthetic" || metadata.kind === "python_oracle", `${sourceId} has an unknown source kind`);
    if (metadata.kind === "synthetic") {
      assert.equal(metadata.live_recorded, false, sourceId);
      assert.equal(metadata.oracle_commit, undefined, sourceId);
      assert.equal(metadata.recorded_at, undefined, sourceId);
      assert.equal(metadata.capture_sha256, undefined, sourceId);
    } else {
      assert.equal(metadata.live_recorded, true, sourceId);
      assert.equal(metadata.oracle_commit, pythonOracleCommit, sourceId);
      assert.doesNotThrow(() => new Date(metadata.recorded_at ?? "invalid").toISOString(), sourceId);
      assert.match(metadata.capture_sha256 ?? "", /^[0-9a-f]{64}$/u, sourceId);
      const fixture = await readFile(join(sourcesRoot, sourceId, metadata.fixture));
      assert.equal(createHash("sha256").update(fixture).digest("hex"), metadata.capture_sha256, sourceId);
    }
  }
}

export async function test_golden_fixtures_contain_no_credentials_or_live_deployment_identity(): Promise<void> {
  const forbidden = [
    secretSentinel,
    "ontrack.infotech.monash.edu",
    "auth-token",
    "refresh_token",
    "access_token",
    "authentication_token",
    "cookie",
    ...(process.env.GOLDEN_FORBIDDEN_VALUES ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name !== "README.md") {
        const contents = await readFile(path, "utf8");
        const normalized = contents.toLowerCase();
        for (const value of forbidden) assert.equal(normalized.includes(value.toLowerCase()), false, `${path} contains ${value}`);
        assert.doesNotMatch(contents, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/u, path);
        assert.doesNotMatch(contents, /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]{12,}/iu, path);
      }
    }
  };
  await visit(root);
}
