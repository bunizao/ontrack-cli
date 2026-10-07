import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { CliError } from "../src/errors.js";
import { readSecretLine } from "../src/secret-input.js";

function terminalInput() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(raw: boolean): void };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (raw) => { input.isRaw = raw; };
  return input;
}

export async function test_secret_input_keeps_multiline_pastes_hidden_and_restores_raw_mode(): Promise<void> {
  const input = terminalInput();
  const output = new PassThrough();
  let displayed = "";
  output.on("data", (chunk: Buffer) => { displayed += chunk.toString(); });
  const secret = "curl 'https://school.example.edu/api/auth/access-token' \\\n  -H 'Cookie: username=alice; refresh_token=test-refresh'";
  const result = readSecretLine(input as unknown as NodeJS.ReadStream, output, new AbortController().signal);
  assert.equal(input.isRaw, true);
  input.write("\x1b[20");
  input.write(`0~${secret}\x1b[2`);
  input.write("01~");
  assert.equal(await result, secret);
  assert.equal(input.isRaw, false);
  assert.ok(displayed.includes("not echoed"));
  assert.ok(displayed.includes("\x1b[?2004l"));
  assert.doesNotMatch(displayed, /test-refresh|username=alice/);
}

export async function test_secret_input_can_be_cancelled_and_restores_the_terminal(): Promise<void> {
  const input = terminalInput();
  const result = readSecretLine(input as unknown as NodeJS.ReadStream, new PassThrough(), new AbortController().signal);
  input.write("test-secret\x03");
  await assert.rejects(result, (error) => error instanceof CliError && error.category === "cancellation");
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
}

export async function test_secret_input_bounds_piped_data_and_supports_abort(): Promise<void> {
  const large = new PassThrough();
  const result = readSecretLine(large as unknown as NodeJS.ReadStream, new PassThrough(), new AbortController().signal);
  large.end("x".repeat(65_537));
  await assert.rejects(result, (error) => error instanceof CliError && /too large/u.test(error.message));
  const pending = new PassThrough();
  const controller = new AbortController();
  const cancelled = readSecretLine(pending as unknown as NodeJS.ReadStream, new PassThrough(), controller.signal);
  controller.abort();
  await assert.rejects(cancelled, (error) => error instanceof CliError && error.category === "cancellation");
}
