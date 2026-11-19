import assert from "node:assert/strict";

import { consumePairing, openPairing, PAIRING_ATTEMPTS, PAIRING_TTL_MS, type PairingRecord, type PairingStore } from "../src/worker/pairing.js";

function store(): PairingStore & { record: PairingRecord | undefined } {
  const state: { record: PairingRecord | undefined } & PairingStore = {
    record: undefined,
    get: async () => state.record,
    put: async (record) => { state.record = record; },
    delete: async () => { state.record = undefined; },
  };
  return state;
}

export async function test_pairing_code_is_short_readable_and_stored_only_as_a_digest(): Promise<void> {
  const pairing = store();
  const opened = await openPairing(pairing, 1_000);
  assert.match(opened.code, /^[A-HJ-NP-Z2-9]{8}$/u);
  assert.equal(opened.expires_at, new Date(1_000 + PAIRING_TTL_MS).toISOString());
  assert.ok(!JSON.stringify(pairing.record).includes(opened.code));
}

export async function test_pairing_code_works_once_and_ignores_case_and_spaces(): Promise<void> {
  const pairing = store();
  const { code } = await openPairing(pairing, 0);
  const typed = `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`;
  assert.deepEqual(await consumePairing(pairing, typed, 1), { ok: true });
  assert.deepEqual(await consumePairing(pairing, code, 2), { ok: false, attemptsLeft: 0 });
}

export async function test_pairing_closes_after_too_many_wrong_codes(): Promise<void> {
  const pairing = store();
  const { code } = await openPairing(pairing, 0);
  for (let left = PAIRING_ATTEMPTS - 1; left >= 0; left -= 1) {
    assert.deepEqual(await consumePairing(pairing, "WRONGONE", 1), { ok: false, attemptsLeft: left });
  }
  assert.deepEqual(await consumePairing(pairing, code, 2), { ok: false, attemptsLeft: 0 });
}

export async function test_pairing_code_expires(): Promise<void> {
  const pairing = store();
  const { code } = await openPairing(pairing, 0);
  assert.deepEqual(await consumePairing(pairing, code, PAIRING_TTL_MS), { ok: false, attemptsLeft: 0 });
  assert.equal(pairing.record, undefined);
}
