import assert from "node:assert/strict";

import { openSystemBrowser, type BrowserCommandRunner } from "../src/browser.js";

export async function test_system_browser_opener_uses_platform_default_handlers(): Promise<void> {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const run: BrowserCommandRunner = async (command, args) => { calls.push({ command, args }); };
  const url = "https://identity.example.edu/saml?request=opaque";

  await openSystemBrowser(url, { platform: "darwin", run });
  await openSystemBrowser(url, { platform: "win32", run });
  await openSystemBrowser(url, { platform: "linux", run });

  assert.deepEqual(calls, [
    { command: "open", args: [url] },
    { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] },
    { command: "xdg-open", args: [url] },
  ]);
}

export async function test_system_browser_opener_propagates_launch_failures(): Promise<void> {
  await assert.rejects(
    openSystemBrowser("https://identity.example.edu", {
      platform: "linux",
      run: async () => { throw new Error("xdg-open is unavailable"); },
    }),
    /xdg-open is unavailable/u,
  );
}
