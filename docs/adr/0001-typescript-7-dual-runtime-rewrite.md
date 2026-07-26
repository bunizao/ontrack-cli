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

Three further problems were identified while planning this rewrite. They change the plan rather than merely adding work.

### The parity baseline cannot currently be captured

The cutover gate depends on freezing today's observable behavior as fixtures. Today's executable cannot authenticate, so only error paths are observable. Projects, Project detail, Unit detail, and Teaching Role responses cannot be recorded at all, and the CLI output derived from them cannot be captured.

Without a working reference implementation, "parity" degrades into "the TypeScript implementation agrees with fixtures hand-transcribed from upstream Ruby entities", which tests the transcription rather than the port. This is a sequencing defect in the plan, not an acceptable residual risk.

### Date handling is untyped and its timezone assumption is unexamined

Upstream exposes two different kinds of time value, and the CLI treats both as opaque strings.

`TaskEntity` renders `due_date`, `submission_date`, `completion_date`, `target_due_date`, and `target_start_date` through `format_with: :date_only`, so they arrive as `YYYY-MM-DD` civil dates carrying no time and no offset. It renders `moved_to_discuss_at` and `discuss_timeout_expiry_at` unformatted, so those arrive as full timestamps.

Lexicographic comparison is therefore accidentally correct for the five civil dates, which is why the overdue calculation mostly works today. The real defects are narrower and less visible:

- `today` is the client's local date, while the deadline is a civil date in the deployment's timezone. A user outside that timezone sees off-by-one overdue flags near midnight, and nothing records that this assumption was made.
- Both timestamp fields are dropped by `_task_from_payload`, so the Discuss timeout this ADR requires cannot be shown at all.
- The sort key has no total ordering guarantee and would break silently if any value changed format.

The correction is not to parse everything into instants. Collapsing a civil date into an instant manufactures a time of day and a timezone that upstream never supplied. The two kinds need distinct types.

### Repeating the authentication handshake on every invocation is not viable

The Okta subprocess provider costs a process spawn plus a refresh-cookie exchange. Without a cached Authenticated Session, every command pays it. The requirement that tokens never appear in output does not imply they are never stored; those are separate concerns and the current plan conflates them.

### External constraints

TypeScript 7.0.2 is a production release, not a preview. Its native compiler is suitable for build and type-check work, but 7.0 has no compiler interface for tools to import. Node also instructs package authors to publish JavaScript rather than raw TypeScript.

The relevant lesson from Bun's Zig-to-Rust rewrite is process, not scale: document the mapping, preserve the executable contract, trial one vertical slice, use compiler failures as a work queue, smoke-test each command, and accept no skipped parity tests. Bun's central claim is that the test suite must be independent of the implementation being replaced. A literal Python-file-to-TypeScript-file port would preserve the shallow modules and known wrong behavior, so this rewrite will preserve the public interface while deepening the implementation.

## Decision

### Step zero: restore the Python reference implementation

Before the TypeScript branch begins bulk work, the Python implementation gets one deliberately disposable release:

- replace the in-process `okta_auth.adapter` import with a subprocess call to the installed `okta` executable, restoring authentication;
- add an `ONTRACK_HTTP_RECORD` capture mode to the HTTP seam that writes sanitized request/response pairs;
- publish it as the final Python release, carrying a migration notice.

This is not the rejected "patch Python and postpone the rewrite" option. It is a prerequisite of the rewrite: it exists to produce a working oracle to diff against and to make fixture capture mechanical rather than transcribed. The code is expected to be discarded.

### One replacement, two acceptance gates

The repository will move to TypeScript in one replacement branch and merge without a permanent Python/TypeScript dispatch bridge.

The branch has two gates:

1. **Cutover gate**: preserve the existing command names, flags, exit behavior, config/environment names, and JSON shapes while fixing confirmed authentication, Task Schedule, Task Status, grade, and error-handling defects.
2. **Feature gate**: add missing capabilities only through the new deep modules after the cutover contract suite passes under both runtimes.

Only the cutover gate blocks the merge. The feature gate is ordinary post-merge work, so the replacement branch is short-lived rather than a multi-week integration branch.

Known correctness fixes are part of parity because reproducing known wrong output is not useful compatibility. Other new product behavior must not be mixed into the first gate.

Before bulk implementation, add a short `PORTING.md` that maps every current command, configuration source, output shape, error category, and Python concept to its TypeScript home. Trial the `projects --json` vertical slice before translating the rest.

### Toolchain and distribution

- Pin `typescript@7.0.2` initially and invoke `tsc` as a process. Do not import the TypeScript compiler until a stable post-7.0 compiler interface exists.
- Emit ESM JavaScript from `src/` to `dist/` with `module: "nodenext"`, explicit `rootDir`, explicit Node types, strict checking, and `.js` extensions in relative imports.
- Publish only emitted JavaScript, declarations where useful, README, and license. Raw `.ts` is not the installed executable.
- Support maintained Node releases with `node >=22`; test Node 22 and 24. Test the same artifact on current Bun, initially Bun 1.3.14 or newer.
- Keep `dist/cli.js` as the `ontrack` executable with a Node shebang. Bun users run the same artifact with `bun` or `bun run --bun ontrack`; the shebang must not be presented as automatic Bun selection.
- Publish as `@bunizao/ontrack` and keep the executable name `ontrack`. Both unscoped candidates are taken by other publishers — `ontrack-cli` and `ontrack` both resolve on the registry — so a scope is mandatory rather than stylistic. An npm account confers its own username as a scope, so registering the account is the whole of the ownership work and is the first task of the plan. The `-cli` suffix is dropped because the scope already disambiguates.
- A Bun-compiled standalone executable may be added later as a convenience artifact. It is not the primary distribution and does not replace Node verification.

There will be no Node implementation and Bun implementation. Core code must use the common subset: standard JavaScript, `fetch`, `URL`, `AbortController`, `FormData`, web streams, and Bun-compatible `node:` modules. `Bun.*`, `bun:*`, runtime-specific source branches, and raw-TypeScript execution are excluded from the shared artifact.

#### Dependency policy

The runtime dependency budget is near zero, and each of these is a decision rather than an omission:

- **Argument parsing**: `node:util` `parseArgs`. The command surface is six commands with flag options; a parser framework would exceed the problem.
- **Terminal tables**: a local renderer of roughly sixty lines. Table output is not a compatibility contract (see below), so matching an existing library's box drawing has no value.
- **Runtime validation**: hand-written narrow readers per entity, not a schema library. The required policy is deliberately lenient in one direction and strict in another — tolerate absent new fields, reject wrong shapes, and preserve unknown enum keys verbatim. General-purpose schema libraries default to the opposite bias, and configuring them back costs more than the readers.

#### Repository tooling

- TypeScript 7 has no compiler API, so type-aware linting via `typescript-eslint` is unavailable without adopting Microsoft's side-by-side TypeScript 6 alias. This project will not adopt that alias. `tsc --noEmit` is the type gate, and a non-type-aware linter may be used for style only.
- CI pins exact Node and Bun versions. A separate scheduled job runs the current releases of both and is allowed to fail, so upstream drift arrives as information rather than as a blocked merge.

### Deep module shape

The rewrite will not mirror the current Python file layout.

| Module | Interface responsibility | Implementation hidden behind the interface |
| --- | --- | --- |
| **Project Snapshot** | Load and inspect one Project consistently | Project/Unit join, Task Definitions, effective Task Schedules, Unit grade definitions, Task Status semantics, injected clock |
| **Authenticated Session** | Resolve, cache, and diagnose one verified session for an OnTrack Deployment | provider precedence, Okta subprocess, cookie normalization, refresh exchange, token expiry, on-disk session cache, provenance, validation |
| **OnTrack HTTP contract** | Return validated domain values or stable errors | auth headers, cancellation, timeouts, JSON validation, multipart, binary streams, response decoding, safe retry after refresh |
| **Task Submission** | Submit, inspect, and download a Submission | upload requirements, prerequisite checks, local file validation, multipart construction, status transition, PDF processing, history |
| **Result Rendering** | Render one command result as terminal or JSON output | stable machine keys, tables, secret filtering, ANSI isolation |

The command parser remains thin. It resolves arguments, invokes a deep module, renders its result, and maps stable errors to exit codes.

The effective Task Schedule is internal to Project Snapshot. It has one implementation, so a separate seam would be hypothetical. Likewise, there is no runtime seam in application code: Node and Bun are verification targets for the same implementation, not adapters.

The true external OnTrack seam has at least two adapters: the production `fetch` adapter and fixture/mock adapters used by contract tests. Tests and callers use the same module interface.

Three values are threaded explicitly rather than reached for globally, because each is a source of untestable behavior when it is ambient:

- **Clock**: Project Snapshot receives a constructed value supplying both the current instant and today's local civil date, since it compares against each. `ONTRACK_NOW` overrides it and is documented as test-only, outside the CLI compatibility contract.
- **AbortSignal**: one signal originates at the process entry point, is bound to SIGINT on POSIX and Ctrl+Break on Windows, and is passed through to every HTTP call. Windows cannot target Ctrl+C at a detached process group; Ctrl+Break is the native group-addressable console interrupt. This is an API requirement, not an implementation detail: without it, the required interrupt behavior cannot be met, and retrofitting the signature later touches every layer.
- **Environment and platform**: configuration path resolution is a pure function of `env` and `platform`. Nothing below the command layer reads `process.env` directly.

### Stable CLI and upstream contract

The existing top-level commands remain available at the cutover gate:

- `user`
- `auth check`
- `projects`
- `project <project_id>`
- `tasks <project_id>`
- `roles`

New hierarchical commands may be added later, but the current commands will remain aliases through the next major interface review.

`--yaml` is removed. It is the one output mode with no evidence of use, and every retained mode multiplies the golden-case matrix that guards the cutover; carrying it costs half again as many parity cases for the six commands. `--json` piped through a YAML converter covers the same need. Removing a flag is a breaking change, which is affordable exactly once, at `0.x`.

#### Key naming and what is actually frozen

**snake_case is the permanent convention** for structured output, across the current commands and every command added later. It mirrors the upstream OnTrack payloads, so a reader comparing CLI output against an API response sees the same names. Converting to camelCase would be churn with no user benefit.

The convention is permanent; individual field names are not yet frozen. They freeze at the first release after the cutover, not at today's shapes, because correcting Task Schedule necessarily changes what today's keys mean:

- `due_date` and `deadline` currently hold the effective due date and the Task Definition due date respectively, which does not survive the precedence rules below;
- Discuss timeout must become its own field rather than being folded into a date the CLI already publishes;
- `target_due_date` and `target_start_date` are dropped today and must appear.

Recording "existing keys are compatibility contracts" without this exemption would have made the cutover gate unsatisfiable by its own terms.

**Structured output is a byte-level contract; terminal output is not.** Only `--json` output is compared byte-for-byte against the Python reference, and only for keys that survive the exemption above. Terminal rendering is free to differ, and matching the previous table layout is explicitly not a goal. Recording this now prevents the parity step from being spent aligning box-drawing characters.

**Stream discipline is part of the contract.** On success, stdout carries only the command result and stderr may carry diagnostics. On failure, stdout is empty. `ontrack projects --json | jq` must therefore work in every success case and produce nothing in every failure case.

All upstream payloads enter the program as `unknown` and are validated at the HTTP seam. A wrong response shape is a contract error, never an empty successful result. Unknown Task Status keys are preserved in structured output and receive a safe fallback label; known status classification is exhaustive and tested. Unit `grade_definitions` drive grade output, with the historic five-grade catalog used only when older deployments omit the field.

#### Time semantics

Upstream time values have two types, assigned by the reader layer at the HTTP seam:

- **Civil date** for every field upstream renders with `format_with: :date_only` — the five Task schedule fields, Unit start and end dates, and Task Definition dates. Modelled as a year-month-day value and never widened to an instant.
- **Instant** for fields upstream renders unformatted — `moved_to_discuss_at` and `discuss_timeout_expiry_at`.

Comparison happens within a type. Overdue is a civil-date comparison against today; Discuss timeout is an instant comparison against now. Converting between the two requires an explicit named conversion, so the place where a timezone is assumed is always visible.

"Today" is the client's local civil date. The deployment's timezone is not exposed by the API, so no better answer is available; the assumption is recorded here, implemented in exactly one place, and injected for tests rather than read from an ambient clock. String comparison of upstream date values is prohibited.

Sort keys must be total. Task ordering is `(effective due date, abbreviation, task id)` so ties cannot reorder between runs.

#### Task Schedule precedence

Project Snapshot owns current upstream schedule precedence:

1. When flexible dates are enabled, use a Task's Project-specific target date.
2. When flexible dates are enabled and no Project-specific date exists, use the Task Definition date for the Project's target grade when present.
3. Otherwise use the Task's effective due date.
4. Finally fall back to the Task Definition target date.

The final deadline also includes Project special consideration. Start dates follow the analogous upstream precedence. Discuss timeout dates are distinct from submission deadlines and must not be collapsed into one `due_date` field.

#### Error model and exit codes

Errors carry a category as a closed enumeration: usage, config, auth, upstream contract, upstream API, network, and cancellation. Exhaustiveness of the category-to-exit-code mapping is enforced at compile time and asserted at runtime.

At the cutover gate the observable exit codes remain what the Python implementation actually produces today: `0` on success, `2` for usage errors, `130` on interrupt, and `1` for everything else. Granular per-category exit codes are a later interface change, not part of parity. The internal categories exist now so that change costs a mapping table rather than a refactor.

Cancellation through POSIX SIGINT or Windows Ctrl+Break must produce exit `130`, no partial structured output on stdout, and no stack trace.

#### Retry safety

At most one retry after a token refresh, and only for idempotent requests. A `419` on a GET refreshes and retries once. A `419` on a submission upload does not retry. A refresh that keeps yielding an unusable token must terminate rather than loop.

#### Configuration

Config path resolution honours `XDG_CONFIG_HOME` before falling back to `~/.config/ontrack-cli`. The current implementation hard-codes the fallback; this is corrected at the cutover gate as an ordinary defect fix.

User profiles and credentials become separate values. Access and refresh tokens must never appear in command output, diagnostics, fixtures, or Teaching Role serialization.

### Authentication providers

Authentication source precedence is explicit and testable:

1. explicit environment credentials;
2. explicit config credentials;
3. migration-only cached-user JSON;
4. a best-effort direct-browser provider, isolated by profile;
5. an existing Okta session exposed by the `okta` executable.

`ONTRACK_DOUBTFIRE_USER_JSON` remains a migration-only compatibility input for the cutover release, but the obsolete browser-local-storage copy procedure is removed from primary documentation.

The Okta adapter consumes only stable JSON command output. It must not import a language package or read private `okta-auth` storage files. Normal commands may reuse an existing session; only an explicit interactive `auth login` command may start `okta login`. Diagnostics distinguish missing provider, missing stored session, login failure, cookie exchange failure, expired access token, and upstream authorization failure.

#### Session cache

A resolved Authenticated Session is cached at the configured config directory as `session.json` with `0600` permissions, holding the base URL, username, access token, `auth_token_expiry`, and provenance. Commands reuse a cached session until it expires; only expiry or an upstream rejection re-enters the provider chain.

Storage and output are distinct policies. Tokens are written to this file and to nowhere else — never to stdout, stderr, diagnostics, fixtures, golden files, or logs.

The 2026-07-27 authentication closeout added the direct-browser provider after a Node/Bun spike. It reads only the `username` and `refresh_token` pair for the access-token endpoint, never merges profiles, and treats every read/decryption failure as an unavailable provider. macOS Chromium uses Keychain plus the browser's SQLite database without a native dependency; Firefox uses read-only SQLite on supported platforms. Linux and Windows Chromium decryption remain unsupported and fall through to the `okta` subprocess provider.

### Capability order

After the cutover gate, add capabilities in this order:

1. **Student read surface**: Task detail, Task Schedule, resources, prerequisites, comments, current Submission, Submission history/files, portfolio state, and calendar.
2. **Student write surface**: planning/target dates, Submission upload, status transition, comments, extension requests, Project target/submitted grade, and portfolio generation.
3. **Staff surface**: student lists, Task inbox, moderation, overflow claiming, marking sessions, enrolment, role mutation, and reporting.

Status transition and file upload must arrive through the Task Submission module rather than as independent commands. Upstream requirements can require files, prerequisite state, group data, or long-running PDF processing; a status-only command would expose a misleading partial workflow.

The CLI will not attempt to mirror every upstream route. A capability enters the public interface only when its complete user workflow and authorization behavior can be tested.

## Verification architecture

The test suite is part of the architecture, not a consequence of it. Bun's transferable claim is that the suite must be independent of the implementation being replaced; this project applies the same requirement one level higher, to the test runtime.

### Layers

Five layers with distinct boundaries, so that any new check has one obvious home:

| Layer | Scope | Boundary | Input | Expected size |
| --- | --- | --- | --- | --- |
| **L0** | Domain logic | Pure functions, no I/O | Constructed domain values | ~100 assertions |
| **L1** | Upstream contract | Reader layer | Recorded and synthetic response bodies | ~30 entities × 2 |
| **L2** | Command golden | Command handler with a fixture HTTP adapter, in process | argv and env | ~18 golden cases |
| **L3** | Process black box | A spawned `dist/cli.js` | argv, env, signals | ~8 cases |
| **L4** | Packaged smoke | Tarball installed into an empty directory | Installed executable | 3 runtimes × 3 platforms |

L0 carries most of the suite. Task Schedule precedence, status classification, grade resolution, instant arithmetic, path resolution, colour decisions, and serialization are all pure and belong there. L3 exists only for behavior a real process can exhibit and an in-process test cannot: shebang and shim resolution, argv handling, stream separation, and signals. A verification plan weighted toward L3 and L4 produces a slow matrix whose failures report only a wrong exit code.

### Runner independence

Test files contain no runner-specific API. They export named cases as plain async functions and assert with `node:assert/strict`, which is stable across all three target runtimes. A local harness of roughly forty lines collects, executes, and reports them.

`bun test` is a different runner, so passing under it is not evidence about Node. `node:test` is the only zero-dependency candidate that could serve all three, but its completeness under Bun must be measured rather than assumed. The harness makes that measurement optional rather than load-bearing: if `node:test` proves adequate, the harness is replaced and no test file changes.

### Golden test design

Golden cases live in `tests/golden/<command>/<case>/` containing `argv`, `env`, `stdout.json`, `stderr.txt`, and `exit`. Adding a case is copying a directory.

Every source of non-determinism has a designated control:

| Source | Failure it causes | Control |
| --- | --- | --- |
| Current date and instant | `is_overdue` flips daily | Injected clock via `ONTRACK_NOW` |
| Terminal width | Different wrapping | Fixed `COLUMNS` |
| Colour | ANSI leaks into golden files | Explicit no-colour; structured output never carries ANSI, asserted separately |
| Key order | Diff noise | Explicit ordering at serialization |
| Sort ties | Rows reorder between runs | Total sort key |

Golden files are pretty-printed and committed. Regeneration happens through `UPDATE_GOLDEN=1` and never by hand, because a hand-edited golden file silently stops being a baseline. Regeneration diffs must be reviewable, which is why the files are formatted rather than minified.

### Required checks the previous plan did not name

1. **Unknown enum handling as a property.** Generated unknown status keys must round-trip through structured output unchanged and receive a safe label. Testing only `rediscuss` would pass today and fail on the next upstream addition.
2. **Minimal and maximal payload fixtures per entity.** The smallest legal response and a fully populated response, for every entity. This pair is what enforces the "tolerate absent new fields" policy for older deployments.
3. **Secret leakage as a mechanical guarantee.** Every command in every output mode runs with a sentinel token value; the sentinel must appear zero times across stdout and stderr. Golden files and fixtures are scanned for the same sentinel, and CI scans the repository for credential-shaped strings.
4. **Exit code exhaustiveness.** Every error category has a mapping, asserted by iterating the enumeration.
5. **Stream separation.** stdout parses as JSON in every `--json` success case and is empty in every failure case.
6. **Colour and TTY decisions as pure functions.** Tested at L0 against synthetic stream and env inputs. No pseudo-terminal infrastructure; the defect lives in the decision, not in the terminal.
7. **Cancellation.** POSIX SIGINT or Windows Ctrl+Break during an in-flight request yields exit `130`, empty stdout, and no stack trace.
8. **Timeout and network failure.** An adapter that never resolves proves the abort path fires, without depending on wall-clock delays.
9. **Retry safety.** Three cases: GET refreshes and retries once; upload does not retry; repeated refresh failure terminates.
10. **Configuration precedence.** Ordered-pair coverage — for each adjacent pair of sources, the higher one wins — rather than the full combination space.
11. **Platform path resolution.** Windows paths, `~` expansion, and `XDG_CONFIG_HOME` tested as pure functions across simulated platforms.

The general rule behind several of these: platform and runtime variance is pushed into pure decision functions, so the expensive matrix only covers what genuinely cannot be simulated. Otherwise the CI matrix becomes the test suite.

### The `okta` test double

Five of the six required authentication diagnostics can only be triggered by controlling the subprocess, so a fake `okta` executable is a prerequisite for that requirement rather than a convenience.

It is a directory placed at the front of `PATH` containing both a shell script and a `.cmd` shim, and it simulates: success; absent from `PATH`; present with no stored session; login failure; malformed JSON on stdout; exit `0` with empty stdout; and a hanging process.

The same double is what makes the subprocess smoke test runnable on Linux, macOS, and Windows CI without installing a Python toolchain.

### Fixture capture and sanitization

Fixtures are recorded from the live deployment through the Python recorder, not transcribed from upstream source.

- Sanitization rebuilds each fixture from an allowlist of validated fields with substituted values. Denylist scrubbing of recorded bodies is prohibited, because it leaks whatever the pattern did not anticipate.
- The recorder never writes the `Auth-Token` header or cookies to disk. Stripping happens at write time, not before commit.
- Only endpoints scoped to the authenticated user are recorded. The staff surface returns other people's personal data; those fixtures are synthesized, never recorded, and never committed.
- CI scans fixtures for the deployment hostname and for real usernames as a backstop.

### Anti-stub gates

Compilation-only stubs are rejected, and the rejection is enforced rather than reviewed:

- CI fails on any skipped or pending test, or on an unimplemented-marker string in `src/`.
- A test enumerates commands from the parser definition and asserts each has at least one L2 golden case, so a command cannot be added without one.
- Coverage floors apply to domain modules only. A global threshold would reward writing meaningless renderer tests.

### Out of scope

Table layout is not asserted. The TypeScript compiler is not tested. No test in CI contacts the live deployment; a manually invoked `verify:live` script covers that before a release. Thin command handlers get no separate unit tests, because L2 already covers them.

### Merge gates

The cutover cannot merge until all of the following are true:

- Black-box fixtures capture current command names, flags, exit codes, stdout/stderr separation, config precedence, JSON shapes, and representative requests, recorded from a Python implementation that can authenticate.
- Sanitized upstream fixtures cover current projects, project detail, unit detail, roles, malformed responses, unknown statuses, custom grades, Task Schedule variants, HTTP 401/419, and network failure, each in minimal and maximal form.
- The same contract tests run under Node 22, Node 24, and current Bun.
- Packed-package smoke tests install the tarball in an empty directory and exercise help, version, `projects --json`, a representative error, subprocess authentication, and the platform console interrupt under both runtimes.
- Config paths, executable shims, Unicode, and terminal behavior run on Linux, macOS, and Windows CI.
- The secret sentinel appears in no output, fixture, or golden file.
- No parity test is deleted or skipped to make the rewrite pass. Compilation-only stubs do not count as implementation.

## Considered options

### Patch Python and postpone the rewrite

Rejected as a destination. It would fix immediate drift but would not meet the Node/Bun distribution goal, and the current shallow modules would keep spreading upstream behavior through commands and rendering.

This is distinct from the disposable Python release adopted above, which exists only to produce a working oracle and mechanical fixtures for the rewrite, and which is discarded afterwards.

### Port each Python file mechanically

Rejected. Bun's mechanical port was protected by a mature architecture and a language-independent, million-assertion suite. Here it would preserve duplicated auth exchange, unchecked dictionaries, hard-coded grades/statuses, pass-through output helpers, and misplaced Project Snapshot logic.

### Maintain a Python/TypeScript hybrid

Rejected. It creates two install stacks and a temporary dispatch interface that has no long-term value. The old Python executable remains available from released versions while the replacement branch reaches parity.

### Write Bun-native code and add Node fallbacks

Rejected. Two runtime paths create a new seam without product value. Bun's Node compatibility lets one Node-compatible artifact serve both runtimes, and the CI matrix is the test surface.

### Adopt an existing test framework

Rejected for the contract suite. `bun test` cannot produce Node evidence. `vitest` under Bun exercises Bun's Node compatibility layer more than it exercises this package. `node:test` is a reasonable eventual host, but committing the suite to any runner's API makes the suite depend on the runtime it is supposed to be comparing. A minimal harness over `node:assert` keeps that choice reversible at no meaningful cost.

### Validate upstream payloads with a schema library

Rejected. The required behavior is asymmetric: lenient about absent fields, strict about wrong shapes, and lossless about unknown enum values. Schema libraries default to the opposite bias, and the configuration needed to restore it is larger and less legible than hand-written readers for roughly thirty entities.

## Consequences

- The install channel moves from a Python tool to a scoped npm package; existing users need an explicit migration path, delivered as a notice in the final Python release.
- One disposable Python release is written and then discarded. This is accepted cost in exchange for a falsifiable parity claim.
- Direct browser-cookie extraction is a best-effort provider at the first TypeScript cutover. Inaccessible or incompatible browser profiles fall through to stored Okta sessions, interactive Okta login, or explicit credentials.
- Machine-output compatibility becomes deliberate and testable instead of an accidental consequence of Python dataclasses. Terminal output correspondingly loses any compatibility guarantee.
- Upstream drift becomes local to Project Snapshot and the OnTrack HTTP contract, increasing locality and leverage for future commands.
- The Task row schema changes at the cutover. Correcting Task Schedule redefines `due_date` and `deadline`, adds the Discuss timeout and the two target dates, and therefore breaks any consumer that parsed the current shape. Field names freeze only after this.
- `--yaml` disappears. This is the one removal a user could notice immediately.
- Overdue results will differ from today's output for users whose local date differs from the deployment's. This is a fix, and it will look like a regression to anyone diffing against the old behavior.
- Tokens are now written to disk. The security posture shifts from "not stored" to "stored with restrictive permissions and never emitted", which must be documented for users.
- Type-aware linting is unavailable for the life of TypeScript 7.0. `tsc --noEmit` carries that load.
- The first implementation work is contract capture and module deepening, not bulk syntax translation.
- Staff capability remains intentionally incomplete until the smaller student surface proves the interfaces, and staff fixtures will be synthetic for privacy reasons even when that work begins.
