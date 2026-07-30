# macOS Chrome cookie access from a CLI

Research date: 2026-07-29. This note distinguishes filesystem consent from cookie decryption and compares the current OnTrack, Moodle, and Boss implementations.

## Conclusion

`sudo` cannot turn Chrome cookie extraction into a single Touch ID authorization. Two independent gates are involved:

| Gate | What is protected | Who decides | Possible prompt |
| --- | --- | --- | --- |
| TCC / Files & Folders | Chrome's `Cookies` SQLite database under another app's data | macOS privacy policy | A system consent notification or a manual Files & Folders toggle |
| Keychain item access | The `Chrome Safe Storage` secret used to decrypt database values | Keychain access control | Password or Touch ID |

Approving the second gate does not approve the first. Apple states that mandatory access control applies to every process, including processes running as root, and that TCC has no API surface. Therefore `sudo`, a privileged helper, `authopen`, and `osascript ... with administrator privileges` are not supported ways to grant or bypass Chrome App Data access. [Source: [Apple DTS, “On File System Permissions”](https://developer.apple.com/forums/thread/678819)]

The best supported way to extract cookies from the user's existing Chrome profile without Files & Folders access is a narrowly scoped Chrome extension using `chrome.cookies`, with an exact OnTrack host permission, and a local handoff through Chrome Native Messaging. This replaces a macOS privacy prompt with a one-time Chrome extension/host permission grant; it is not a biometric prompt.

## Why elevation does not solve it

Apple describes Files & Folders and Full Disk Access as mandatory access control, separate from traditional BSD ownership and mode bits. Its DTS guidance is explicit that “all processes on the system, including those running as root, are subject to MAC.” The same guidance says a Files & Folders alert is displayed only once, the decision is remembered, and “TCC has no API surface.” This matches the observed missed-notification behavior; it is not evidence of a SQLite or Node bug. [Source: [Apple DTS, “On File System Permissions”](https://developer.apple.com/forums/thread/678819)]

Apple's platform security guide likewise says apps that need full-storage access must be explicitly added in System Settings. The supported non-interactive administration route is a Privacy Preferences Policy Control payload on a managed Mac; Apple documents that it requires user-approved device management and cannot be installed as an ordinary local preference. [Sources: [Controlling app access to files in macOS](https://support.apple.com/guide/security/controlling-app-access-to-files-secddd1d86a6/web), [Privacy Preferences Policy Control payload](https://support.apple.com/guide/deployment/privacy-preferences-policy-control-payload-dep38df53c2a/web)]

The built-in `tccutil(1)` interface only resets recorded decisions so the system can decide or prompt again; it has no `grant` operation. `SystemPolicyAppDataDetailed` is an internal service name rather than a documented product API, so OnTrack should not build an authorization flow around it.

### `authopen`, Authorization Services, and AppleScript

The macOS 27 `authopen(1)` manual says it obtains a `sys.openfile.*` Authorization Services right, opens a named file, and can return its descriptor to a parent process. That is an elevation mechanism for an `open(2)` operation, not a documented TCC grant. No Apple source documents `authopen` as bypassing Files & Folders, while Apple's TCC guidance says root remains subject to MAC and TCC exposes no authorization API. Treating `authopen` as a TCC escape would therefore be unsupported and security-version-dependent.

The same conclusion applies to an Authorization Services privileged helper and to AppleScript's `do shell script ... with administrator privileges`: they can authorize an operation as an elevated user, but elevation does not grant the separate TCC privacy class. [Sources: [Authorization Services Programming Guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/authorization_concepts/01introduction/introduction.html), [AppleScript `do shell script` technical note](https://developer.apple.com/library/archive/technotes/tn2065/_index.html), [Apple DTS on root and MAC](https://developer.apple.com/forums/thread/678819)]

This rules out the proposed “Touch ID to obtain a privileged file descriptor” as a supported product design. A local experiment on one OS build would not make it safe to ship.

## What the Touch ID prompt actually unlocks

Apple documents Keychain as storage for passwords, keys, and login tokens, with the secret value protected separately from metadata and requiring Secure Enclave participation. Keychain access controls can require user presence or biometrics. That authorization applies to a Keychain item, not to unrelated files protected by TCC. [Sources: [Keychain data protection](https://support.apple.com/guide/security/keychain-data-protection-secb0694df1a/web), [Accessing Keychain Items with Face ID or Touch ID](https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id)]

`browser_cookie3` demonstrates the split directly. On macOS it invokes `/usr/bin/security -q find-generic-password -w -a Chrome -s "Chrome Safe Storage"`, then separately opens the Chrome SQLite database in read-only modes and falls back to copying it. A Keychain prompt can occur during the first operation; `EPERM` can still occur during the second. [Source: [`browser_cookie3` macOS key and database access](https://github.com/borisbabic/browser_cookie3/blob/03895797e48dd107806db171d8392c562151807d/browser_cookie3/__init__.py#L111-L121)] [Source: [`browser_cookie3` read-only and copy paths](https://github.com/borisbabic/browser_cookie3/blob/03895797e48dd107806db171d8392c562151807d/browser_cookie3/__init__.py#L346-L395)]

## What Boss and Moodle actually do

Boss does not convert TCC into Touch ID. At commit `05c70049`, it calls `browser_cookie3`, catches every extraction exception, and returns no cookie on inaccessible profile paths. Its login manager then silently falls through to CDP, QR-over-HTTP, and finally Patchright. The visible biometric event is the `Chrome Safe Storage` Keychain lookup; a database denial is hidden by the fallback chain. [Sources: [Boss cookie extraction](https://github.com/can4hou6joeng4/boss-agent-cli/blob/05c70049e2c29c487741956354b62a4627a302e0/src/boss_agent_cli/auth/cookie_extract.py#L19-L100), [Boss login fallbacks](https://github.com/can4hou6joeng4/boss-agent-cli/blob/05c70049e2c29c487741956354b62a4627a302e0/src/boss_agent_cli/auth/manager.py#L38-L107)]

The current `moodle-cli` uses the same raw-profile model as OnTrack: `@steipete/sweet-cookie` reads Chrome, Edge, Firefox, and Safari profiles; Moodle then tries `okta-auth-cli`, or opens a browser and polls the same browser provider. It has no macOS permission bypass. [Sources: [`moodle-cli` source order](https://github.com/bunizao/moodle-cli/blob/f6dd27df5fdd6d597759d71b9ae3a258c09725a2/src/auth.ts#L95-L128), [`moodle-cli` browser provider](https://github.com/bunizao/moodle-cli/blob/f6dd27df5fdd6d597759d71b9ae3a258c09725a2/src/auth.ts#L217-L240), [`moodle-cli` browser polling](https://github.com/bunizao/moodle-cli/blob/f6dd27df5fdd6d597759d71b9ae3a258c09725a2/src/auth.ts#L131-L182)]

## Supported options

### 1. Chrome extension plus Native Messaging — recommended for direct extraction

Chrome's supported `chrome.cookies` API can retrieve cookies, including records marked `HttpOnly`, when the extension has the `cookies` permission and host permission for the target URL. Optional host permission can be requested at the moment of export and must originate in a user gesture. Chrome Native Messaging then lets the extension start and exchange JSON with a registered local host. [Sources: [`chrome.cookies`](https://developer.chrome.com/docs/extensions/reference/api/cookies), [runtime permission requests](https://developer.chrome.com/docs/extensions/reference/api/permissions), [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)]

For OnTrack, the narrow design is:

1. Install a signed MV3 extension and its native messaging host once.
2. Request only the configured OnTrack origin, not `<all_urls>`.
3. On an explicit user click, call `chrome.cookies.getAll()` and retain only `username` and `refresh_token`.
4. Send the pair to the local host over Native Messaging, exchange it for an OnTrack access token, and never persist or log the raw cookies.

Sweet Cookie already contains a user-triggered MV3 exporter that requests exact origins and calls `chrome.cookies.getAll()`, so it is a useful implementation reference. It currently exports through clipboard/file; OnTrack would replace that manual handoff with Native Messaging. [Sources: [Sweet Cookie extension design](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/docs/spec.md#L169-L215), [extension implementation](https://github.com/steipete/sweet-cookie/blob/c5dcb164c8e76b861627b9d35952932b6a58d831/apps/extension/src/popup.ts#L109-L130)]

Tradeoff: the first run requires installing/approving an extension and granting the OnTrack host permission in Chrome. After that, Chrome owns database access and decryption, so Terminal Files & Folders and Chrome Safe Storage prompts are removed from this path.

### 2. CDP — useful only when Chrome is already debug-enabled

The DevTools Protocol exposes `Storage.getCookies`, but it needs a debugger connection. Since Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` are ignored for the default Chrome data directory unless Chrome is launched with a non-standard `--user-data-dir`. It therefore cannot be retrofitted into an ordinary already-running default profile as a general solution. [Sources: [CDP `Storage.getCookies`](https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-getCookies), [Chrome 136 remote-debugging change](https://developer.chrome.com/blog/remote-debugging-port)]

### 3. Browser callback — best UX, but not cookie extraction

If the OnTrack server can add a loopback/custom-scheme callback that returns a one-time authorization code, the CLI can open the normal browser, receive the code, and exchange it without reading browser storage. This is the cleanest end-user login, but the classic form requires a server protocol change and does not satisfy a strict requirement to extract the existing Chrome cookie.

A variant needs **no server change**: because `/api/auth/access-token` is a same-origin credentialed endpoint, a small JavaScript snippet run on the OnTrack tab (DevTools console today, an MV3 extension later) does `fetch('/api/auth/access-token', {credentials:'include'})` — the browser attaches the `HttpOnly` cookies automatically — and hands the resulting `auth_token` to a CLI loopback server via a top-level navigation to `http://127.0.0.1:<port>/cb`. Top-level navigations are exempt from mixed-content blocking and Private Network Access preflights, so no CORS setup is required. This is the shipped design; see below.

### 4. Signed native app/helper — improves attribution, not consent

A signed, notarized app with a stable bundle identity can make the one-time Files & Folders decision belong to OnTrack rather than Terminal or `node`, which improves diagnostics and avoids interpreter attribution problems. It still cannot programmatically grant the privacy permission or replace the user's Allow/toggle action with Touch ID. [Source: [Apple DTS, “On File System Permissions”](https://developer.apple.com/forums/thread/678819)]

## Recommendation for `ontrack-cli`

Keep raw Chrome database extraction as a zero-install fast path for users who already granted Files & Folders access. When direct cookie reuse fails, warn once and continue through the loopback sign-in instead of polling an unreadable database or requiring a privacy grant. Do not add `sudo`, `authopen`, a privileged helper, or AppleScript elevation. A narrow extension plus Native Messaging can later replace the manual DevTools paste without changing the browser-side exchange.

## Shipped design (2026-07-30)

`loginAuthenticatedSession` in [`src/auth.ts`](../../src/auth.ts) now uses the option-3 no-server-change variant instead of polling the cookie database:

1. **Fast path unchanged.** It still tries `exchangeBrowserCookieCandidates` first, so Firefox (plaintext `cookies.sqlite`, no Keychain/FDA) and already-granted Chrome log in with zero interaction.
2. **Loopback sign-in.** On no readable session it discovers the SAML URL, starts a `127.0.0.1` HTTP server on an ephemeral port (`nodeLoopbackListener`), and prints a one-time snippet with the port and a random `state` baked in.
3. **Browser does the credentialed call.** The user signs in, then pastes the snippet into the OnTrack tab's DevTools console. It runs the same `POST /api/auth/access-token` the CLI used to run server-side, then navigates to `http://127.0.0.1:<port>/cb?state=…&token=…`.
4. **CLI receives the token.** The listener resolves only on a matching `state`, validates a non-expired expiry, and persists the session. No Chrome cookie read, no Keychain, no Files & Folders.

`src/cli.ts` no longer hard-fails on a Chrome `EPERM`; it warns and falls through to the loopback flow. The next step, when the console paste becomes a friction point, is to replace the manual snippet with the narrow MV3 extension from option 1 — the in-browser logic is identical.
