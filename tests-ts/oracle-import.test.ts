import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const importer = join(process.cwd(), "scripts", "golden-import-oracle.mjs");

interface OracleRecord {
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

function validRecord(): OracleRecord {
  return {
    request: {
      method: "GET",
      path: "/api/projects",
      params: { include_inactive: true },
    },
    response: {
      status_code: 200,
      json: [],
    },
  };
}

function validRolesRecord(): OracleRecord {
  return {
    request: {
      method: "GET",
      path: "/api/unit_roles",
      params: { active_only: true },
    },
    response: {
      status_code: 200,
      json: [{
        id: 1,
        role: "Student",
        observer_only: false,
        can_mark_overflow_tasks: true,
        mentor_id: 1,
        tutor_note_count: 3,
        unit: { id: 1, code: "UNIT", name: "Unit" },
        user: {
          id: 1,
          username: "recorded-user",
          first_name: "Recorded",
          last_name: "User",
          email: "recorded-user@example.invalid",
          nickname: "Recorded",
        },
      }],
    },
  };
}

async function importRecord(record: unknown): Promise<SpawnSyncReturns<string>> {
  const directory = await mkdtemp(join(tmpdir(), "ontrack-oracle-import-"));
  try {
    await mkdir(join(directory, "tests", "golden", "sources"), { recursive: true });
    const capture = join(directory, "capture.jsonl");
    await writeFile(capture, `${JSON.stringify(record)}\n`, "utf8");
    return spawnSync(process.execPath, [
      importer,
      capture,
      "oracle-test",
      "2026-07-26T12:00:00Z",
      "--confirm-live-recorded",
    ], { cwd: directory, encoding: "utf8" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function test_oracle_import_rejects_a_noncanonical_recorded_id(): Promise<void> {
  const record = validRecord();
  const result = await importRecord({
    ...record,
    request: { ...record.request, path: "/api/projects/9182", params: {} },
    response: { ...record.response, json: {} },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /request path was not sanitized/u);
}

export async function test_oracle_import_rejects_unallowlisted_request_params(): Promise<void> {
  const record = validRecord();
  const result = await importRecord({
    ...record,
    request: { ...record.request, params: { username: "recorded-user" } },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /request params were not sanitized/u);
}

export async function test_oracle_import_requires_the_recorders_projects_param_shape(): Promise<void> {
  const record = validRecord();
  const result = await importRecord({
    ...record,
    request: { ...record.request, params: {} },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /request params were not sanitized/u);
}

export async function test_oracle_import_rejects_a_scalar_response_body(): Promise<void> {
  const record = validRecord();
  const result = await importRecord({
    ...record,
    response: { ...record.response, json: "recorded personal data" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid response body/u);
}

export async function test_oracle_import_rejects_scalar_items_in_a_projects_response(): Promise<void> {
  const record = validRecord();
  const result = await importRecord({
    ...record,
    response: { ...record.response, json: ["recorded personal data"] },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid response body/u);
}

export async function test_oracle_import_accepts_a_python_recorder_shaped_capture(): Promise<void> {
  const result = await importRecord(validRecord());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Imported 1 sanitized record/u);
}

export async function test_oracle_import_accepts_a_sanitized_user_roles_capture(): Promise<void> {
  const result = await importRecord(validRolesRecord());
  assert.equal(result.status, 0, result.stderr);
}

export async function test_oracle_import_rejects_raw_role_user_pii(): Promise<void> {
  const record = validRolesRecord();
  const result = await importRecord({
    ...record,
    response: {
      ...record.response,
      json: [{
        id: 1,
        role: "Student",
        unit: { id: 1, code: "UNIT", name: "Unit" },
        user: { id: 1, username: "real-monash-identity" },
      }],
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /was not rebuilt by the Python allowlist sanitizer/u);
}

export async function test_oracle_import_rejects_a_raw_role_mentor_id(): Promise<void> {
  const record = validRolesRecord();
  const role = (record.response.json as readonly Record<string, unknown>[])[0]!;
  const result = await importRecord({
    ...record,
    response: {
      ...record.response,
      json: [{ ...role, mentor_id: 9182 }],
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /was not rebuilt by the Python allowlist sanitizer/u);
}

export async function test_oracle_import_rejects_unexpected_roles_params(): Promise<void> {
  const record = validRolesRecord();
  const result = await importRecord({
    ...record,
    request: { ...record.request, params: { active_only: true, user_id: 9182 } },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /request params were not sanitized/u);
}

export async function test_oracle_import_rejects_extra_envelope_fields(): Promise<void> {
  const record = validRecord();
  const variants: readonly unknown[] = [
    { ...record, provenance: "private-value" },
    { ...record, request: { ...record.request, trace: "private-value" } },
    { ...record, response: { ...record.response, trace: "private-value" } },
  ];
  for (const variant of variants) {
    const result = await importRecord(variant);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected record fields/u);
  }
}

export async function test_oracle_import_rejects_an_invalid_http_status(): Promise<void> {
  const record = validRecord();
  const result = await importRecord({
    ...record,
    request: { ...record.request, path: "/api/projects/1", params: {} },
    response: { ...record.response, status_code: 700, json: {} },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid response/u);
}
