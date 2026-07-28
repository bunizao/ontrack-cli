# Architecture

`ontrack-cli` is a TypeScript command-line client for Doubtfire / OnTrack. TypeScript compiles to standard ESM in `dist/`; the same files run on Node.js and Bun.

## Request flow

```text
command line
  -> argument parsing
  -> authenticated session
  -> OnTrack HTTP client
  -> validated API entities
  -> application and domain rules
  -> JSON or terminal output
```

Each boundary has one job:

| Area | Modules | Responsibility |
| --- | --- | --- |
| CLI | `cli.ts`, `cli-app.ts` | Parse commands, select output mode, and map failures to exit codes. |
| Application | `application.ts`, `resources.ts` | Coordinate authenticated reads, downloads, and atomic local file writes. |
| Authentication | `auth.ts`, `browser-cookies.ts`, `config.ts` | Resolve credentials, exchange application cookies, and maintain the local access-token cache. |
| Transport | `http.ts` | Apply timeouts, cancellation, authentication headers, and the safe retry policy. |
| OnTrack API | `ontrack.ts`, `readers.ts` | Call API routes and validate unknown response payloads. |
| Domain | `project-snapshot.ts`, `time.ts`, `status.ts`, `grades.ts` | Build task schedules and interpret statuses and grades. |
| Output | `serialize.ts`, `render.ts` | Produce stable JSON and readable terminal tables. |

## Authentication boundary

Explicit credentials take precedence over the local session cache and browser cookies. Browser cookies are filtered for the target deployment and exchanged in memory for an OnTrack access token. Browser profiles are searched first; compatible Playwright storage-state files are an optional fallback. Refresh cookies are not copied into the CLI cache.

The cache stores the deployment URL, username, access token, expiry, and credential source with file mode `0600`. A rejected GET request may refresh credentials and retry once. The client does not retry mutating requests.

Browser discovery is delegated to `@steipete/sweet-cookie`, then normalized behind the local browser-cookie boundary. Each browser is queried separately so credentials from different profiles are never combined. Non-fatal provider warnings are shown during `auth login` without exposing cookie values.

When no usable browser cookies exist, `auth login` requests a dynamic SAML URL from `/api/auth/method`, waits for terminal confirmation, opens the system browser, and polls supported browser profiles for the completed OnTrack session. Other commands never start interactive authentication.

Authentication cannot extend a server-side session beyond the deployment or identity provider policy. When the browser session expires, interactive sign-in is required.

## Data contracts

OnTrack API readers receive upstream responses as `unknown` and validate them before use. Optional fields remain optional, the client preserves unknown task statuses, and unit-provided grade definitions override legacy labels.

The CLI distinguishes calendar dates from timestamps. Task schedules combine unit defaults, target-grade dates, project overrides, extensions, and special consideration without converting civil dates into artificial instants.

Terminal commands render command-specific tables by default. Successful `--json` commands write one JSON value to stdout. Prompts and diagnostics stay on stderr, including the warning emitted before reading task chat history. Failures leave stdout empty. Usage errors exit with code `2`, cancellation exits with `130`, and other failures exit with `1`.

Resource downloads resolve the unit through the selected project. The aggregate route returns a unit-wide ZIP; individual routes return a PDF, ZIP, or linked resource. Task selection normally follows generated project tasks. If the API returns no project tasks, selection falls back to definitions from that project's authorized unit, which remain visible in the project output. The transport follows validated HTTP 206 ranges, including credential refresh between chunks. Responses are limited to 256 MiB. ZIP and PDF signatures are validated where applicable, upstream placeholder files are rejected, and filenames are reduced to safe basenames. An atomic no-overwrite commit prevents replacing an existing destination.

Chat summaries use unread counts already present in the project snapshot and do not fetch comment streams. History requests are restricted to one selected task to avoid an implicit N+1 request and unexpected read-state changes. The upstream history route returns group-task comments chronologically and marks non-discussion comments as read; the CLI reports that side effect on stderr. Terminal rendering omits email addresses and strips control sequences while JSON preserves the validated API payload.

## Verification

Tests use dependency injection at the HTTP, clock, browser-cookie, prompt, and browser-opening boundaries. The suite includes:

- unit and integration tests in `tests/*.test.ts`;
- synthetic response fixtures in `tests/fixtures/`;
- command compatibility cases in `tests/golden/`;
- package smoke tests against the packed npm artifact;
- CI coverage across Linux, macOS, and Windows with Node.js and Bun.

Maintainers sanitize the compatibility corpus before committing it. The corpus contains no live credentials or deployment identity.
