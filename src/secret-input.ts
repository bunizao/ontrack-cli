import { StringDecoder } from "node:string_decoder";

import { CliError } from "./errors.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export async function readSecretLine(input: NodeJS.ReadStream, output: NodeJS.WritableStream, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new CliError("cancellation", "Authentication cancelled.");
  const terminal = input.isTTY === true;
  const wasRaw = input.isRaw;
  if (terminal) {
    // Disable echo before accepting input, including pastes that arrive early.
    input.setRawMode(true);
    output.write("OnTrack credentials (not echoed): \x1b[?2004h");
  }
  try {
    return await new Promise<string>((resolve, reject) => {
      const decoder = new StringDecoder("utf8");
      let content = "";
      let size = 0;
      let pasting = false;
      let escape = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
        input.removeListener("error", onError);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve(content.trim());
      };
      const append = (text: string) => {
        size += Buffer.byteLength(text);
        if (size > 65_536) finish(new CliError("auth", "The pasted credentials are too large."));
        else content += text;
      };
      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        if (!terminal) { append(text); return; }
        for (const ch of text) {
          if (settled) return;
          if (escape) {
            escape += ch;
            if (escape === PASTE_START) { pasting = true; escape = ""; }
            else if (escape === PASTE_END) { finish(); return; }
            else if (!PASTE_START.startsWith(escape) && !PASTE_END.startsWith(escape)) escape = "";
            continue;
          }
          const code = ch.charCodeAt(0);
          if (code === 27) { escape = ch; continue; }
          if (pasting) { append(ch); continue; }
          if (code === 3 || code === 4) { onAbort(); return; }
          if (code === 13 || code === 10) { finish(); return; }
          if (code === 8 || code === 127) {
            const last = [...content].at(-1) ?? "";
            if (last) {
              content = content.slice(0, -last.length);
              size -= Buffer.byteLength(last);
            }
          } else if (code >= 32) append(ch);
        }
      };
      const onEnd = () => { append(decoder.end()); finish(); };
      const onError = () => finish(new CliError("auth", "Could not read credentials from stdin."));
      const onAbort = () => finish(new CliError("cancellation", "Authentication cancelled."));
      const timer = setTimeout(() => finish(new CliError("auth", "Timed out waiting for credentials.")), 300_000);
      input.on("data", onData).once("end", onEnd).once("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else if (input.readableEnded) onEnd();
    });
  } finally {
    input.pause();
    if (terminal) {
      output.write("\x1b[?2004l\n");
      input.setRawMode(wasRaw);
    }
  }
}
