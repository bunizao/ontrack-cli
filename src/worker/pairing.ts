// One-time pairing codes for approving an MCP client. `ontrack mcp pair` opens a
// window with the owner token; the person types the code on the approval page, so
// the long-lived owner token never has to leave the machine that deployed the Worker.

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_ATTEMPTS = 5;
// No 0/O, 1/I/L: the code is read off one screen and typed into another.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LENGTH = 8;

export interface PairingRecord {
  readonly digest: string;
  readonly expiresAt: number;
  readonly attempts: number;
}

export interface PairingStore {
  get(): Promise<PairingRecord | undefined>;
  put(record: PairingRecord): Promise<void>;
  delete(): Promise<void>;
}

export type PairingResult = { readonly ok: true } | { readonly ok: false; readonly attemptsLeft: number };

/** Replaces any open window with a new code. */
export async function openPairing(store: PairingStore, now = Date.now()): Promise<{ code: string; expires_at: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH));
  // 256 is a multiple of 32, so the modulo is unbiased.
  const code = Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
  const expiresAt = now + PAIRING_TTL_MS;
  await store.put({ digest: await digest(code), expiresAt, attempts: 0 });
  return { code, expires_at: new Date(expiresAt).toISOString() };
}

/** A right code closes the window; so do an expired window and the last wrong try. */
export async function consumePairing(store: PairingStore, submitted: string, now = Date.now()): Promise<PairingResult> {
  // Hash before reading: from here on only storage calls await, which a Durable Object's
  // input gate keeps from interleaving, so two requests cannot both spend one code.
  const hashed = await digest(normalize(submitted));
  const record = await store.get();
  if (!record || record.expiresAt <= now || record.attempts >= PAIRING_ATTEMPTS) {
    await store.delete();
    return { ok: false, attemptsLeft: 0 };
  }
  if (hashed === record.digest) {
    await store.delete();
    return { ok: true };
  }
  const attempts = record.attempts + 1;
  if (attempts >= PAIRING_ATTEMPTS) await store.delete();
  else await store.put({ ...record, attempts });
  return { ok: false, attemptsLeft: PAIRING_ATTEMPTS - attempts };
}

function normalize(code: string): string {
  return code.replace(/[\s-]/gu, "").toUpperCase();
}

async function digest(code: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
