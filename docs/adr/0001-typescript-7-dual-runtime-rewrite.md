---
status: accepted
date: 2026-07-26
---

# Rewrite the CLI in TypeScript 7 for Node and Bun

Replace the Python implementation in one cutover with emitted TypeScript 7 ESM JavaScript. Node and Bun will execute the same artifact; the rewrite will preserve the current command interface first, correct confirmed OnTrack drift at the cutover gate, and add missing student workflows only after parity is measurable.

The evidence and primary sources behind this decision are recorded in [TypeScript 7, dual-runtime packaging, and OnTrack upstream research](../research/typescript-7-dual-runtime-and-ontrack-api.md).

## Context

The current implementation has more than a language problem:

- The live Monash deployment still exposes the routes used by the CLI, but `ontrack auth check --json` cannot obtain credentials. The advertised `okta-auth` integration imports a Python package that is absent from the isolated `ontrack-cli` tool environment, even though the separate `okta` executable is installed.
- The Project view calculates Task dates from an obsolete subset of the payload. It ignores per-Project target dates, per-grade date overrides, special consideration, and Discuss timeout dates.
- The status catalog lacks `assess_in_portfolio`, `attention_required`, and `rediscuss`. This is not only a label issue: `assess_in_portfolio` is final upstream but the CLI can mark it overdue.
- Grades are hard-coded as F/P/C/D/HD even though current Units define their own grade labels and abbreviations.
- The HTTP seam accepts unchecked dictionaries, silently turns some malformed responses into empty lists, and leaks network exceptions past the CLI error model.
- Only seven tests remain. No successful command flow, HTTP contract fixture, Project Snapshot, renderer, or runtime behavior is covered.

TypeScript 7.0.2 is a production release, not a preview. Its native compiler is suitable for build and type-check work, but 7.0 has no compiler interface for tools to import. Node also instructs package authors to publish JavaScript rather than raw TypeScript.

The relevant lesson from Bun's Zig-to-Rust rewrite is process, not scale: document the mapping, preserve the executable contract, trial one vertical slice, use compiler failures as a work queue, smoke-test each command, and accept no skipped parity tests. A literal Python-file-to-TypeScript-file port would preserve the shallow modules and known wrong behavior, so this rewrite will preserve the public interface while deepening the implementation.

## Decision

### One replacement, two acceptance gates

The repository will move to TypeScript in one replacement branch and merge without a permanent Python/TypeScript dispatch bridge.

The branch has two independent gates:

1. **Cutover gate**: preserve the existing command names, flags, exit behavior, config/environment names, and JSON/YAML shapes while fixing confirmed authentication, Task Schedule, Task Status, grade, and error-handling defects.
2. **Feature gate**: add missing capabilities only through the new deep modules after the cutover contract suite passes under both runtimes.

Known correctness fixes are part of parity because reproducing known wrong output is not useful compatibility. Other new product behavior must not be mixed into the first gate.

Before bulk implementation, add a short `PORTING.md` that maps every current command, configuration source, output shape, error category, and Python concept to its TypeScript home. Trial the `projects --json` vertical slice before translating the rest.

### Toolchain and distribution

- Pin `typescript@7.0.2` initially and invoke `tsc` as a process. Do not import the TypeScript compiler until a stable post-7.0 compiler interface exists.
- Emit ESM JavaScript from `src/` to `dist/` with `module: "nodenext"`, explicit `rootDir`, explicit Node types, strict checking, and `.js` extensions in relative imports.
- Publish only emitted JavaScript, declarations where useful, README, and license. Raw `.ts` is not the installed executable.
- Support maintained Node releases with `node >=22`; test Node 22 and 24. Test the same artifact on current Bun, initially Bun 1.3.14 or newer.
- Keep `dist/cli.js` as the `ontrack` executable with a Node shebang. Bun users run the same artifact with `bun` or `bun run --bun ontrack`; the shebang must not be presented as automatic Bun selection.
- Use a verified project-owned npm scope while retaining the executable name `ontrack`. The working package name is `@bunizao/ontrack-cli`, but release is blocked until scope ownership is confirmed. The unscoped `ontrack-cli` name belongs to another publisher.
- A Bun-compiled standalone executable may be added later as a convenience artifact. It is not the primary distribution and does not replace Node verification.

There will be no Node implementation and Bun implementation. Core code must use the common subset: standard JavaScript, `fetch`, `URL`, `AbortController`, `FormData`, web streams, and Bun-compatible `node:` modules. `Bun.*`, `bun:*`, runtime-specific source branches, and raw-TypeScript execution are excluded from the shared artifact.

### Deep module shape

The rewrite will not mirror the current Python file layout.

| Module | Interface responsibility | Implementation hidden behind the interface |
| --- | --- | --- |
| **Project Snapshot** | Load and inspect one Project consistently | Project/Unit join, Task Definitions, effective Task Schedules, Unit grade definitions, Task Status semantics, deterministic current date |
| **Authenticated Session** | Resolve and diagnose one verified session for an OnTrack Deployment | provider precedence, Okta subprocess, cookie normalization, refresh exchange, token expiry, provenance, validation |
| **OnTrack HTTP contract** | Return validated domain values or stable errors | auth headers, timeouts, JSON validation, multipart, binary streams, response decoding, safe retry after refresh |
| **Task Submission** | Submit, inspect, and download a Submission | upload requirements, prerequisite checks, local file validation, multipart construction, status transition, PDF processing, history |
| **Result Rendering** | Render one command result as terminal, JSON, or YAML output | stable machine keys, tables, secret filtering, ANSI isolation |

The command parser remains thin. It resolves arguments, invokes a deep module, renders its result, and maps stable errors to exit codes.

The effective Task Schedule is internal to Project Snapshot. It has one implementation, so a separate seam would be hypothetical. Likewise, there is no runtime seam in application code: Node and Bun are verification targets for the same implementation, not adapters.

The true external OnTrack seam has at least two adapters: the production `fetch` adapter and fixture/mock adapters used by contract tests. Tests and callers use the same module interface.

### Stable CLI and upstream contract

The existing top-level commands remain available at the cutover gate:

- `user`
- `auth check`
- `projects`
- `project <project_id>`
- `tasks <project_id>`
- `roles`

Existing snake_case JSON/YAML keys are compatibility contracts for those commands. New hierarchical commands may be added later, but the current commands will remain aliases through the next major interface review.

All upstream payloads enter the program as `unknown` and are validated at the HTTP seam. A wrong response shape is a contract error, never an empty successful result. Unknown Task Status keys are preserved in structured output and receive a safe fallback label; known status classification is exhaustive and tested. Unit `grade_definitions` drive grade output, with the historic five-grade catalog used only when older deployments omit the field.

Project Snapshot owns current upstream schedule precedence:

1. When flexible dates are enabled, use a Task's Project-specific target date.
2. When flexible dates are enabled and no Project-specific date exists, use the Task Definition date for the Project's target grade when present.
3. Otherwise use the Task's effective due date.
4. Finally fall back to the Task Definition target date.

The final deadline also includes Project special consideration. Start dates follow the analogous upstream precedence. Discuss timeout dates are distinct from submission deadlines and must not be collapsed into one `due_date` field.

User profiles and credentials become separate values. Access and refresh tokens must never appear in command output, diagnostics, fixtures, or Teaching Role serialization.

### Authentication providers

Authentication source precedence is explicit and testable:

1. explicit environment credentials;
2. explicit config credentials;
3. migration-only cached-user JSON;
4. an existing Okta session exposed by the `okta` executable;
5. an optional direct-browser provider when one has passed cross-platform proof.

`ONTRACK_DOUBTFIRE_USER_JSON` remains a migration-only compatibility input for the cutover release, but the obsolete browser-local-storage copy procedure is removed from primary documentation.

The Okta adapter consumes only stable JSON command output. It must not import a language package or read private `okta-auth` storage files. Normal commands may reuse an existing session; only an explicit interactive `auth login` command may start `okta login`. Diagnostics distinguish missing provider, missing stored session, login failure, cookie exchange failure, expired access token, and upstream authorization failure.

Direct Chrome/Firefox/Brave/Edge database extraction is deferred until a cross-platform spike covers macOS Keychain, Linux keyrings, Windows DPAPI, browser schema drift, and both runtimes. The TypeScript release must not repeat the current unverified “automatic browser auth” claim.

### Capability order

After the cutover gate, add capabilities in this order:

1. **Student read surface**: Task detail, Task Schedule, resources, prerequisites, comments, current Submission, Submission history/files, portfolio state, and calendar.
2. **Student write surface**: planning/target dates, Submission upload, status transition, comments, extension requests, Project target/submitted grade, and portfolio generation.
3. **Staff surface**: student lists, Task inbox, moderation, overflow claiming, marking sessions, enrolment, role mutation, and reporting.

Status transition and file upload must arrive through the Task Submission module rather than as independent commands. Upstream requirements can require files, prerequisite state, group data, or long-running PDF processing; a status-only command would expose a misleading partial workflow.

The CLI will not attempt to mirror every upstream route. A capability enters the public interface only when its complete user workflow and authorization behavior can be tested.

### Verification gates

The cutover cannot merge until all of the following are true:

- Black-box fixtures capture current command names, flags, exit codes, stdout/stderr separation, config precedence, JSON/YAML shapes, and representative requests.
- Sanitized upstream fixtures cover current projects, project detail, unit detail, roles, malformed responses, unknown statuses, custom grades, Task Schedule variants, HTTP 401/419, and network failure.
- The same contract tests run under Node 22, Node 24, and current Bun.
- Packed-package smoke tests install the tarball in an empty directory and exercise help, version, `projects --json`, a representative error, subprocess authentication, and SIGINT under both runtimes.
- Config paths, executable shims, Unicode, and terminal behavior run on Linux, macOS, and Windows CI.
- No parity test is deleted or skipped to make the rewrite pass. Compilation-only stubs do not count as implementation.
- Authenticated fixtures from the configured Monash deployment are captured and sanitized after the Okta subprocess path works; until then, current upstream source fixtures remain an explicit approximation.

## Considered options

### Patch Python and postpone the rewrite

Rejected. It would fix immediate drift but would not meet the Node/Bun distribution goal, and the current shallow modules would keep spreading upstream behavior through commands and rendering.

### Port each Python file mechanically

Rejected. Bun's mechanical port was protected by a mature architecture and a language-independent, million-assertion suite. Here it would preserve duplicated auth exchange, unchecked dictionaries, hard-coded grades/statuses, pass-through output helpers, and misplaced Project Snapshot logic.

### Maintain a Python/TypeScript hybrid

Rejected. It creates two install stacks and a temporary dispatch interface that has no long-term value. The old Python executable remains available from released versions while the replacement branch reaches parity.

### Write Bun-native code and add Node fallbacks

Rejected. Two runtime paths create a new seam without product value. Bun's Node compatibility lets one Node-compatible artifact serve both runtimes, and the CI matrix is the test surface.

## Consequences

- The install channel moves from a Python tool to a scoped npm package; existing users need an explicit migration path.
- Direct browser-cookie extraction is no longer promised at the first TypeScript cutover. Okta subprocess and explicit credentials are the supported interactive and automation paths until the browser spike succeeds.
- Machine-output compatibility becomes deliberate and testable instead of an accidental consequence of Python dataclasses.
- Upstream drift becomes local to Project Snapshot and the OnTrack HTTP contract, increasing locality and leverage for future commands.
- The first implementation work is contract capture and module deepening, not bulk syntax translation.
- Staff capability remains intentionally incomplete until the smaller student surface proves the interfaces.
