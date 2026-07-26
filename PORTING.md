# TypeScript cutover map

The cutover preserves the executable name, retained commands, environment names, JSON naming convention, and current exit codes. It intentionally removes `--yaml` and corrects the task-row fields described in ADR 0001.

| Existing surface | TypeScript home | Cutover behavior |
| --- | --- | --- |
| `user` | `src/commands.ts` | Resolve one authenticated session and emit a token-free user object. |
| `auth check` | `src/commands.ts` | Validate auth against projects and roles and emit counts. |
| `projects` | `src/commands.ts`, `src/ontrack.ts` | Preserve `--include-inactive` and the project JSON shape. |
| `project <id>` | `src/commands.ts`, `src/project-snapshot.ts` | Join Project and Unit through one Project Snapshot. |
| `tasks <id>` | `src/commands.ts`, `src/project-snapshot.ts` | Preserve repeatable `--status`; correct schedules, grades, and statuses. |
| `roles` | `src/commands.ts`, `src/ontrack.ts` | Preserve `--all`; never serialize credentials from nested users. |
| Click parsing | `src/cli.ts` | `node:util` `parseArgs`; usage exits 2. |
| `AuthConfig` and auth helpers | `src/auth.ts`, `src/config.ts` | Explicit credentials, migration JSON, cache, then the `okta` process. |
| `OnTrackClient` | `src/http.ts`, `src/ontrack.ts` | Validated `unknown` input, stable errors, abort, timeout, safe one-shot retry. |
| formatter and output | `src/render.ts` | Stable pretty JSON and local terminal tables; stdout remains result-only. |
| date/status/grade constants | `src/time.ts`, `src/status.ts`, `src/grades.ts` | Typed time values, exhaustive known status metadata, unit grade definitions. |

Configuration precedence is environment, explicit config, migration JSON, session cache, and Okta. `XDG_CONFIG_HOME` precedes the home-directory fallback. `ONTRACK_NOW` is test-only and injects both the current instant and local civil date.

Internal errors use `usage`, `config`, `auth`, `upstream_contract`, `upstream_api`, `network`, and `cancellation`. The cutover maps these to the established public codes: usage 2, cancellation 130, and all other failures 1.
