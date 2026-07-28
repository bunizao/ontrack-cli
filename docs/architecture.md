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

Explicit credentials take precedence over the local session cache and browser cookies. Browser cookies are filtered for the target deployment and exchanged in memory for an OnTrack access token. Refresh cookies are not copied into the CLI cache.

The cache stores the deployment URL, username, access token, expiry, and credential source with file mode `0600`. A rejected GET request may refresh credentials and retry once. The client does not retry mutating requests.

Browser discovery is delegated to `@steipete/sweet-cookie`, then normalized behind the local browser-cookie boundary. Each browser is queried separately so credentials from different profiles are never combined. Non-fatal provider warnings are shown during `auth login` without exposing cookie values.

When no usable browser cookies exist, `auth login` requests a dynamic SAML URL from `/api/auth/method`, waits for terminal confirmation, opens the system browser, and polls supported browser profiles for the completed OnTrack session. Other commands never start interactive authentication.

Authentication cannot extend a server-side session beyond the deployment or identity provider policy. When the browser session expires, interactive sign-in is required.

## Data contracts

OnTrack API readers receive upstream responses as `unknown` and validate them before use. Optional fields remain optional, the client preserves unknown task statuses, and unit-provided grade definitions override legacy labels.

The CLI distinguishes calendar dates from timestamps. Task schedules combine unit defaults, target-grade dates, project overrides, extensions, and special consideration without converting civil dates into artificial instants.

Successful non-interactive `--json` commands write one JSON value to stdout and leave stderr empty. Interactive authentication may write prompts to stderr while keeping stdout machine-readable. Failures leave stdout empty. Usage errors exit with code `2`, cancellation exits with `130`, and other failures exit with `1`.

Resource downloads resolve the unit through the selected project, fetch the aggregate archive through the same authenticated transport, and validate its central-directory structure. Archives are limited to 512 MiB. The complete response is received before an abortable sibling temporary-file write begins. A hard-link commit prevents overwriting an existing destination, and temporary-file cleanup is attempted after success or failure.

## Verification

Tests use dependency injection at the HTTP, clock, browser-cookie, prompt, and browser-opening boundaries. The suite includes:

- unit and integration tests in `tests/*.test.ts`;
- synthetic response fixtures in `tests/fixtures/`;
- command compatibility cases in `tests/golden/`;
- package smoke tests against the packed npm artifact;
- CI coverage across Linux, macOS, and Windows with Node.js and Bun.

Maintainers sanitize the compatibility corpus before committing it. The corpus contains no live credentials or deployment identity.
