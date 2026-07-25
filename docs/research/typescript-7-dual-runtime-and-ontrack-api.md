# TypeScript 7, dual-runtime packaging, and OnTrack upstream research

Status: 2026-07-26

This note is research input for the rewrite ADR. External claims use first-party Bun, Microsoft/TypeScript, Node.js, Doubtfire/OnTrack, and npm registry sources. The OnTrack source comparison is pinned to `doubtfire-api` commit [`c91418e`](https://github.com/doubtfire-lms/doubtfire-api/tree/c91418e128e97df1fb61d0f774715475b757d8f4) and `doubtfire-web` commit [`dc5fc36`](https://github.com/doubtfire-lms/doubtfire-web/tree/dc5fc3633b1d4a13518ae412cd9219f2787326a2), both from the official `11.0.x` branch on 2026-07-24.

## Executive conclusions

1. **TypeScript 7 is suitable as this project's production compiler.** Microsoft announced TypeScript 7.0 as production-ready on 2026-07-08, published it through the normal `typescript` npm package, and reports typical 8x-12x full-build speedups from the Go native port. It is not merely a preview now. However, **TypeScript 7.0 does not expose a compiler API**; Microsoft expects a new and different API in 7.1 and documents side-by-side TypeScript 6 for tools that import `typescript` programmatically. The rewrite should use the TypeScript 7 `tsc` executable as the build/type-check authority, but must not build project tooling around `import "typescript"` yet. ([TypeScript 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/))
2. **Publish JavaScript, not raw TypeScript.** Node's built-in type stripping is stable in current releases, but it ignores `tsconfig.json`, supports only erasable syntax by default, requires explicit file extensions, and deliberately refuses to execute TypeScript under `node_modules`. Node explicitly tells package authors to distribute `.js` files. ([Node TypeScript documentation](https://nodejs.org/api/typescript.html#type-stripping), [dependencies restriction](https://nodejs.org/api/typescript.html#type-stripping-in-dependencies))
3. **Use one Node-compatible ESM artifact for both runtimes.** Bun states that Node-targeted bundles resolve the `node` condition and do not polyfill Bun globals; it also treats Node incompatibility as a Bun bug and runs Node's test suite. The simplest runtime contract is therefore standard JavaScript plus web APIs and supported `node:` modules, with no `Bun.*` usage in the core. ([Bun bundler targets](https://bun.com/docs/bundler#target), [Bun Node.js compatibility](https://bun.com/docs/runtime/nodejs-compat))
4. **A `#!/usr/bin/env node` executable does not automatically run under Bun merely because Bun installed it.** Bun says it respects a Node shebang and launches Node by default; `bun run --bun <binary>` overrides the shebang. The npm executable can remain Node-first while the exact same `dist/cli.js` is tested with both `node` and `bun`. ([Bun runtime, `--bun`](https://bun.com/docs/runtime/index#--bun))
5. **The transferable lesson from Bun's Rust rewrite is to preserve the external contract while changing implementation language.** Bun used a mechanical port with minimal behavioral changes, the same language-independent tests, a written porting guide, a small trial, compiler errors as a work queue, CLI-subcommand smoke tests, adversarial review, and a zero-skipped-test gate. It intentionally deferred idiomatic refactoring until after parity. ([Rewriting Bun in Rust](https://bun.com/blog/bun-in-rust.md))
6. **The OnTrack routes currently used by this CLI have not been removed.** Current upstream still defines `GET /api/auth/method`, `POST /api/auth/access-token`, `GET /api/projects`, `GET /api/projects/:id`, `GET /api/units/:id`, and `GET /api/unit_roles`. The observed drift is chiefly in authentication state, token lifetime, task-status taxonomy, grade configuration, and fields the CLI ignores—not a wholesale route rename. ([authentication routes](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/authentication_api.rb#L390-L406), [projects](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/projects_api.rb#L12-L46), [units](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/units_api.rb#L26-L67), [unit roles](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/unit_roles_api.rb#L11-L25))
7. **Three correctness fixes are urgent before feature expansion:** replace the obsolete local-storage authentication claim with a real session provider, consume the complete upstream task-status set, and render grades from each unit's `grade_definitions` rather than hard-coded HD/P/F constants.
8. **The current generic JSON request path is too shallow for the missing feature set.** Official OnTrack operations include JSON, multipart uploads, binary downloads, comment attachments, and long-running submission/assessment workflows. The TypeScript structure needs a transport module that owns those modes, while OnTrack response mapping and CLI rendering remain separate.

## 1. What Bun's rewrite actually claims

### Transferable lessons

The Bun article makes these explicit claims:

- Rewrites are normally risky. Bun's least-risk design was a **mechanical port**, with minimal behavioral changes and the exact same test suite. Its test suite was independent of the implementation language. ([article, “Why Rust?”](https://bun.com/blog/bun-in-rust.md#why-rust))
- The team chose a single replacement rather than a long-lived incremental bridge because the bridge creates temporary code and medium-term pain. It aimed to preserve architecture, performance, and feature set, then refactor after the new implementation shipped. ([article, “Claude, rewrite Bun in Rust”](https://bun.com/blog/bun-in-rust.md#claude-rewrite-bun-in-rust))
- Before bulk changes, it wrote a pattern mapping (`PORTING.md`), analyzed difficult ownership/lifetime cases, reviewed those rules, and trial-ported only three files. ([article, “Prep work” and “Trial run”](https://bun.com/blog/bun-in-rust.md#prep-work))
- It separated implementer and reviewer contexts, using two or more adversarial reviewers per implementer. Reviewers looked for behavioral mismatches rather than helping the implementation pass. ([article, “Adversarial review”](https://bun.com/blog/bun-in-rust.md#adversarial-review))
- It treated compiler failures, then startup, then individual CLI subcommands, then local tests, then platform CI as progressively stronger work queues. ([article, “Compiler errors as a work queue”](https://bun.com/blog/bun-in-rust.md#compiler-errors-as-a-work-queue))
- It explicitly rejected compilation-only stubs and explanatory comments used to excuse incorrect workarounds. It merged only after all CI tests passed on all platforms and it manually verified tests were not skipped. ([article, “Another false start” and “Merging the Rust rewrite”](https://bun.com/blog/bun-in-rust.md#another-false-start))
- Despite that process, Bun reports 19 known rewrite regressions, all later fixed. A passing port is evidence, not proof that semantic edge cases disappeared. ([article, “Porting mistakes”](https://bun.com/blog/bun-in-rust.md#porting-mistakes))

### How this should translate to `ontrack-cli`

The scale-specific parts—64 agents, four large worktrees, a million-assertion suite, and Rust lifetime analysis—should not be copied. The applicable plan is:

1. Freeze the existing executable contract as black-box tests: command names, flags, exit codes, stdout/stderr separation, JSON/YAML shapes, config precedence, and representative HTTP requests.
2. Write a short Python-to-TypeScript mapping note before porting: dataclass to domain type, `requests.Session` to shared HTTP transport, Click command to command handler, Rich output to renderer, and Python exception to stable exit/error category.
3. Trial-port one vertical slice such as `projects --json`, run it under both Node and Bun against fixtures, and compare it with Python output.
4. Replace the implementation in one cutover branch; do not ship a permanent Python/TypeScript dispatch bridge.
5. Keep “language rewrite” and “new product commands” as separate acceptance gates in that branch. First establish parity plus known upstream correctness fixes; then add missing commands on the new modules.
6. Require the same contract suite under Node and Bun. A Bun-only test runner is not sufficient evidence for Node compatibility.

TypeScript does not provide Rust's memory-safety motivation. The rewrite's value here is runtime reach, stronger domain modeling, a smaller dependency/install surface, and an opportunity to create better seams around volatile upstream behavior. It will not by itself prevent API drift.

## 2. TypeScript 7 status and constraints

### Current status

Microsoft's 2026-07-08 release announcement says:

- TypeScript 7 is the production release of the native Go port and is installed with the normal `typescript` package.
- The port was deliberately kept structurally and logically close to the previous compiler to preserve compatibility.
- TypeScript 7 supports `tsc`, watch mode, build mode, declaration emit, an LSP-based language server, and parallel parsing/checking/emitting. The official native-port status table marks JavaScript emit, declaration emit, build mode, and project references done while its API remains not ready. ([native-port status](https://github.com/microsoft/typescript-go#status))
- TypeScript 7.0 aims to match TypeScript 6.0's checking and command-line behavior when 6.0 is used with stable type ordering and without ignored deprecations.
- TypeScript 7.0 **does not ship a compiler API**. Microsoft provides `@typescript/typescript6`/`tsc6` for tools that still require it and shows an npm-alias configuration for `typescript-eslint`-style consumers.

Source: [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

Therefore, “target TypeScript 7 directly” is appropriate for this CLI if it means:

- `typescript@^7.0.2` provides the authoritative `tsc` build and type-check;
- build scripts invoke `tsc` as a process rather than importing compiler internals;
- any type-aware tool that still imports `typescript` is either omitted initially or isolated with Microsoft's documented TypeScript 6 compatibility alias;
- generated JavaScript is the published runtime artifact.

### Configuration changes the rewrite must account for

TypeScript 7 carries TypeScript 6's new defaults and hard-errors deprecated constructs. The release lists these relevant defaults and removals:

- `strict: true`, `module: "esnext"`, `noUncheckedSideEffectImports: true`, `stableTypeOrdering: true`;
- `rootDir` defaults to `./`, so this project should explicitly set `rootDir: "./src"`;
- `types` defaults to `[]`, so Node types must be listed explicitly;
- `moduleResolution: "node"`/`"node10"`, classic resolution, and `baseUrl` are unsupported; `nodenext` or `bundler` are the supported paths;
- legacy module outputs such as AMD, UMD, and SystemJS are unsupported.

Source: [TypeScript 7.0, “Updates Since 5.x”](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#updates-since-5x-and-new-behaviors-from-60).

For a published Node-compatible ESM CLI, `module: "nodenext"` is the conservative choice. Bun's own suggested TypeScript configuration uses `module: "Preserve"` and `moduleResolution: "bundler"` for Bun-native source execution, but that is not the distribution contract being chosen here. ([Bun TypeScript configuration](https://bun.com/docs/runtime/typescript))

### Recommended Node support floor

Node 20 is no longer in the maintained release schedule. Node 22 is in maintenance through 2027-04-30, Node 24 is LTS through 2028-04-30, and Node 26 does not enter LTS until 2026-10-28. A reasonable published floor today is therefore `node >=22`, with CI on 22 and 24 plus current Bun. ([Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json), [official release index](https://nodejs.org/download/release/index.json))

## 3. Node/Bun dual-runtime packaging

### Distribution shape

Recommended primary package shape:

- package name: a verified scope such as `@bunizao/ontrack-cli`;
- executable name: `ontrack`;
- explicit `"type": "module"`;
- TypeScript source in `src/`, emitted JavaScript in `dist/`;
- executable entry `dist/cli.js` with `#!/usr/bin/env node`;
- relative ESM imports written so emitted JavaScript has explicit `.js` extensions;
- `files` restricted to `dist`, README, and license;
- Node engine floor `>=22`;
- one lockfile chosen as repository policy, without making the installed runtime depend on that package manager.

Node recommends an explicit `type` field and says ESM relative imports require full extensions. The `exports` field can define and encapsulate a small public package surface. ([Node packages](https://nodejs.org/api/packages.html#packagejson-and-file-extensions), [package entry points](https://nodejs.org/api/packages.html#package-entry-points))

Do not publish `.ts` as the executable. Node's stable type stripping ignores `tsconfig.json`, does no type checking, does not transform path aliases, and refuses TypeScript below `node_modules`. ([Node TypeScript support](https://nodejs.org/api/typescript.html))

### Runtime-neutral implementation subset

Prefer:

- global `fetch`, `URL`, `AbortController`, and web streams for HTTP;
- `node:fs`, `node:path`, `node:os`, `node:process`, and basic `node:child_process` operations;
- explicit UTF-8 and binary handling;
- terminal capabilities detected from standard process streams;
- no runtime detection in domain or command code.

Node documents `fetch` as a browser-compatible global, while Bun marks `fetch`, `node:fs`, `node:path`, and many other Node modules as implemented. Bun's `node:child_process` support has listed limitations around identity fields, socket-handle IPC, and exports, but basic subprocess/stdout JSON use is within the common subset and must still be covered by the two-runtime test matrix. ([Node `fetch`](https://nodejs.org/api/globals.html#fetch), [Bun compatibility table](https://bun.com/docs/runtime/nodejs-compat))

Avoid in the shared artifact:

- `Bun.file`, `Bun.spawn`, `Bun.sqlite`, `bun:*`, or Bun macros;
- dependence on Node's raw-TypeScript loader;
- conditional package exports that cause Node and Bun to execute different application implementations;
- a Bun-compiled executable as the only release artifact.

Bun's standalone `--compile` output bundles a copy of the Bun runtime and is platform/architecture specific. It can be an optional convenience release later, but it is not evidence that the npm package works under Node. ([Bun single-file executables](https://bun.com/docs/bundler/executables))

### Required verification matrix

At minimum:

- TypeScript 7 `tsc` check and emit;
- unit/contract tests on Node 22 and Node 24;
- the same unit/contract tests on current Bun;
- packed-package smoke test, installing the tarball into an empty directory;
- `ontrack --help`, `--version`, `projects --json`, a representative error, and SIGINT under both runtimes;
- a subprocess-provider test under both runtimes;
- Linux, macOS, and Windows CI for config paths, executable shims, Unicode, and terminal behavior.

The test matrix is more authoritative than Bun's broad compatibility claim because Bun's published compatibility page currently says it tracks Node v23, while this package will support maintained Node lines newer than that.

## 4. OnTrack upstream comparison

### Existing routes: still current

| CLI behavior | Current official source | Finding |
| --- | --- | --- |
| Probe auth method | [`GET /api/auth/method`](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/authentication_api.rb#L390-L406) | Route and `{ method, redirect_to? }` shape remain valid. |
| Exchange refresh cookie | [`POST /api/auth/access-token`](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/authentication_api.rb#L501-L529) | Route remains valid; successful responses also include `auth_token_expiry`. No valid cookie returns JSON `null`. |
| List projects | [`GET /api/projects`](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/projects_api.rb#L12-L21) | `include_inactive` remains valid. |
| Project and tasks | [`GET /api/projects/:id`](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/projects_api.rb#L23-L46) | Tasks are still nested in project detail. |
| Unit/task definitions | [`GET /api/units/:id`](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/units_api.rb#L43-L67) | Route remains valid, but its schema has expanded. |
| Teaching roles | [`GET /api/unit_roles`](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/unit_roles_api.rb#L11-L25) | `active_only` remains valid. |
| Auth headers | [`Username` and `Auth_Token`](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/helpers/authentication_helpers.rb#L70-L117) | Current `Username` and `Auth-Token` headers are accepted; invalid/expired general tokens produce HTTP 419. |

No checked-in OpenAPI contract was found. The API mounts generated Swagger documentation and labels it `v11.0.0`, so a deployment can drift without the URL path changing. ([API root and generated Swagger](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/api_root.rb#L166-L176))

### Confirmed stale or incomplete behavior

#### A. The documented local-storage authentication path is obsolete

This repository tells users to copy `localStorage.getItem("doubtfire_user")` and supports `ONTRACK_DOUBTFIRE_USER_JSON`. Current official `doubtfire-web` retains that key only to remove it during authentication-service construction; current login state is held in memory and refreshed through secure cookies. ([current authentication service](https://github.com/doubtfire-lms/doubtfire-web/blob/dc5fc3633b1d4a13518ae412cd9219f2787326a2/src/app/api/services/authentication.service.ts#L21-L54), [refresh-token flow](https://github.com/doubtfire-lms/doubtfire-web/blob/dc5fc3633b1d4a13518ae412cd9219f2787326a2/src/app/api/services/authentication.service.ts#L60-L95))

Implications:

- Remove the local-storage copy procedure from the primary auth API.
- Keep explicit username/token environment variables for automation.
- Model `auth_token_expiry`; the official frontend now stores it and cycles the access token. ([token setup](https://github.com/doubtfire-lms/doubtfire-web/blob/dc5fc3633b1d4a13518ae412cd9219f2787326a2/src/app/api/services/authentication.service.ts#L169-L198))
- Treat refresh-cookie exchange as the normal interactive session flow.
- Never serialize access or refresh tokens in diagnostic output.

#### B. The task-status taxonomy is out of date

The CLI knows 12 statuses. Current official web source defines 15, adding:

- `assess_in_portfolio` (already upstream before this CLI was created);
- `attention_required`;
- `rediscuss` (added upstream in July 2026).

It also defines `assess_in_portfolio` as final and all three as submitted states. The CLI currently renders unknown keys verbatim and incorrectly considers `assess_in_portfolio` overdue because its local final-state set omits it. ([official status type and sets](https://github.com/doubtfire-lms/doubtfire-web/blob/dc5fc3633b1d4a13518ae412cd9219f2787326a2/src/app/api/models/task-status.ts#L3-L80), [official labels](https://github.com/doubtfire-lms/doubtfire-web/blob/dc5fc3633b1d4a13518ae412cd9219f2787326a2/src/app/api/models/task-status.ts#L219-L235), [rediscuss change](https://github.com/doubtfire-lms/doubtfire-web/commit/2be78d4e1))

The status catalog should live in one domain module with exhaustive types and tests for labels, final/submitted classification, and unknown future keys. Output should preserve the raw key even when a friendly label is unknown.

#### C. Grades are now unit-defined

The CLI hard-codes Fail/Pass/Credit/Distinction/High Distinction for values `-1..3`. Upstream added customizable unit grade definitions in June 2026 and now exposes both `grade_values` and structured `grade_definitions` on unit payloads. Definitions contain an ID, numeric value, label, and abbreviation. ([unit entity](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/entities/unit_entity.rb#L43-L45), [validation and normalization](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/models/unit.rb#L455-L485), [feature commit](https://github.com/doubtfire-lms/doubtfire-api/commit/57cb9e250))

The mapper must retain `grade_definitions`, and every target/submitted/task grade renderer must resolve through that unit-specific catalog. The historical five-grade mapping is only a fallback for older deployments that omit the field.

#### D. Current response entities expose fields the CLI drops

`TaskEntity` now includes `target_due_date`, `target_start_date`, Discuss timeout timestamps, SCORM extensions, similarity flags, and unread-comment counts. ([official task entity](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/entities/task_entity.rb#L7-L38))

`TaskDefinitionEntity` includes `weighting`, `grade_due_dates`, upload requirements, task sheets/resources, content links, assessment settings, `requires_discussion`, learning outcomes, discussion prompt counts, and overseer information. ([official task-definition entity](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/entities/task_definition_entity.rb#L13-L79))

`ProjectEntity` includes special-consideration days, portfolio files/date, tutorial enrolments, groups, and escalation attempts. ([official project entity](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/entities/project_entity.rb#L3-L35))

The CLI does not need to display every field immediately, but its OnTrack mapping module should retain fields required by planned commands instead of repeatedly joining anonymous dictionaries in renderers.

### Missing user-facing capabilities already present upstream

Suggested implementation order, based on student utility and architectural leverage:

1. **Task detail and resources**: show target start/due dates, upload requirements, task sheet, task resources, grade due dates, and discussion/assessment requirements. Official download routes are in [`TaskDefinitionsApi`](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/task_definitions_api.rb#L620-L703).
2. **Task planning and status updates**: flexible-date planning and state changes use `PUT /api/projects/:id/task_def_id/:task_definition_id[/plan]`. ([tasks API](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/tasks_api.rb#L112-L163))
3. **Submission upload/download/history**: the official surface supports multipart submission, current submission retrieval, timestamps, history, historical files, and latest assessment result. ([portfolio evidence API routes](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/submission/portfolio_evidence_api.rb#L41-L207))
4. **Comments and feedback**: list/add/edit/delete task comments, attachments, discussion prompts/replies, and extension requests. ([task comments routes](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/task_comments_api.rb#L12-L258), [extension requests](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/extension_comments_api.rb#L7-L42))
5. **Project preferences and portfolio**: target grade, portfolio generation, and portfolio download are already exposed. ([project update](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/projects_api.rb#L65-L123), [portfolio API](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/submission/portfolio_api.rb#L14-L88))
6. **Calendar**: authenticated webcal configuration and the GUID feed already exist. ([webcal API](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/webcal_api.rb#L26-L47), [public feed](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/webcal_public_api.rb#L8-L12))
7. **Staff workflows**: student lists, task inbox, moderation, overflow claiming, marking sessions, and reporting should follow after the student surface because their authorization and payloads are broader. ([unit task routes](https://github.com/doubtfire-lms/doubtfire-api/blob/c91418e128e97df1fb61d0f774715475b757d8f4/app/api/units_api.rb#L318-L404))

These capabilities force the transport to support JSON, `FormData`, streamed/binary files, content disposition, and progress/long-running states. Extending today's “always parse JSON” method command by command would spread protocol complexity through every command.

## 5. Local deployment and packaging observations

These observations are from read-only commands on 2026-07-26, not from upstream source:

- The configured deployment is `https://ontrack.infotech.monash.edu`.
- A live unauthenticated request to [`/api/auth/method`](https://ontrack.infotech.monash.edu/api/auth/method) returned `method: "saml"` with a Monash Okta redirect.
- `uv run ontrack auth check --json` failed with “Missing OnTrack credentials”.
- `uv tool list` showed both `ontrack-cli 0.1.2` and `okta-auth-cli 0.2.2` installed as separate uv tools.
- `uv run python` could not resolve the `okta_auth` module. This matches the repository: [`auth.py`](../../ontrack_cli/auth.py) optionally imports `okta_auth.adapter`, while [`pyproject.toml`](../../pyproject.toml) has no `okta-auth-cli` dependency. A separately installed uv tool is intentionally isolated, so the import path silently returns no provider.
- The installed `okta` executable exposes `login`, `check`, and `cookies`, each with JSON output; `okta cookies --json <url>` is the stable process-level handoff available to both Node and Bun.

The TypeScript rewrite should therefore model Okta integration as a subprocess auth provider using basic `node:child_process`, not as an in-process language package. It should:

1. locate `okta` on `PATH`;
2. run `okta check --json <base-url>` for diagnostics;
3. optionally run `okta login --json <base-url>` only in an explicit interactive login command;
4. obtain `okta cookies --json <base-url>` without logging its stdout;
5. send those cookies to `POST /api/auth/access-token`;
6. return the user, access token, and expiry as one auth-session value;
7. distinguish “provider unavailable”, “no stored session”, “login failed”, “cookie exchange failed”, and “API token expired” in diagnostics.

Direct Chrome/Firefox database decryption may remain a later optional provider, but it needs a dedicated cross-platform spike. Neither Node nor Bun offers a standard browser-cookie extraction API, and parity with `browser-cookie3` across macOS Keychain, Linux keyrings, Windows DPAPI, and browser schema changes should not be assumed.

### npm name collision

The public registry currently reports [`ontrack-cli@0.3.0`](https://registry.npmjs.org/ontrack-cli/latest), maintained/published by `markchu`; the unscoped name cannot represent this project. A request for [`@bunizao/ontrack-cli`](https://registry.npmjs.org/%40bunizao%2Fontrack-cli) currently returns 404.

Recommendation: use a verified npm scope such as `@bunizao/ontrack-cli` while retaining the executable name `ontrack`. A registry 404 proves only that no public package is currently returned; it does **not** prove the current npm account has permission to publish that scope. Verify organization/scope ownership before recording the final package name in the ADR.

## 6. Engineering structure implied by the evidence

The rewrite needs a small number of deep modules rather than a TypeScript file-for-file copy:

1. **Command module**: parses arguments and owns exit behavior; command handlers return data rather than print during network operations.
2. **Auth module**: provider chain and an `AuthSession` containing base URL, user, token, and expiry. Environment credentials and Okta subprocess are separate adapters behind this seam.
3. **HTTP transport module**: base URL, auth headers, timeout/abort, JSON/error decoding, multipart, binary streams, and one retry after refresh where safe.
4. **OnTrack module**: route-specific methods and runtime response validation/mapping. It owns snake_case upstream payloads and returns domain values.
5. **Domain module**: projects, units, tasks, status catalog, grade definitions, and due-date semantics. It has no terminal or runtime-specific dependencies.
6. **Output module**: terminal tables plus stable JSON/YAML serialization. Structured output must not contain ANSI sequences or secrets.
7. **Config module**: explicit precedence and platform config locations using shared Node-compatible filesystem APIs.

The most important seam is not “Node versus Bun”; both should run the same artifact. It is **volatile OnTrack protocol versus stable CLI/domain contract**. That is where schema drift, auth renewal, status additions, configurable grades, multipart, and binary behavior belong.

## 7. Decisions the ADR should record

1. Full TypeScript replacement or long-lived hybrid. Evidence favors a full cutover with no permanent Python bridge.
2. Published artifact: emitted ESM JavaScript for Node and Bun; optional Bun native executables are secondary artifacts only.
3. Compiler: TypeScript 7 `tsc`; no dependency on the 7.0 compiler API.
4. Node support floor and exact CI matrix. Evidence supports Node 22/24 plus current Bun.
5. Auth providers: environment plus Okta subprocess first; direct browser database extraction deferred until a cross-platform proof exists.
6. Compatibility policy for older OnTrack deployments: tolerate absent new fields, preserve unknown enum keys, and use legacy grade labels only when `grade_definitions` is absent.
7. Rewrite acceptance gate versus new-feature gate, while still merging as one replacement implementation.
8. npm scope ownership and package name.
9. Whether the CLI public JSON/YAML shapes are compatibility contracts. If yes, capture fixtures before changing field names.

## 8. Uncertainties and required follow-up

- The official `11.0.x` source is newer than the configured Monash deployment may be. Only `/api/auth/method` was probed live; authenticated schema/version checks were impossible because the current CLI could not obtain credentials. Once the Okta subprocess path works, capture sanitized live fixtures for projects, project detail, unit detail, roles, and an error response.
- Generated Swagger is mounted by upstream but no checked-in OpenAPI document was found. Query the configured deployment's Swagger JSON after authentication/version discovery and store only sanitized contract fixtures.
- The exact `okta cookies --json` schema should be contract-tested without committing cookie values. Its executable is local tooling, not an OnTrack-owned API.
- `@bunizao/ontrack-cli` returning 404 does not establish publish authorization.
- Bun's compatibility page says it reflects Node v23, so newer Node behavior still needs direct CI validation.
- Whether users require Windows direct-browser-cookie support is unknown. This materially affects whether browser database extraction belongs in v1 of the TypeScript replacement.
- The desired boundary between student and staff features is a product choice. Upstream exposes both, but staff workflows have a much larger authorization and data surface.

## Primary source index

- Bun rewrite: <https://bun.com/blog/bun-in-rust.md>
- Bun TypeScript: <https://bun.com/docs/runtime/typescript>
- Bun runtime/shebang behavior: <https://bun.com/docs/runtime/index#--bun>
- Bun Node compatibility: <https://bun.com/docs/runtime/nodejs-compat>
- Bun bundler targets: <https://bun.com/docs/bundler#target>
- Bun executable packaging: <https://bun.com/docs/bundler/executables>
- TypeScript 7 release: <https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/>
- TypeScript native-port background: <https://devblogs.microsoft.com/typescript/typescript-native-port/>
- TypeScript native-port status: <https://github.com/microsoft/typescript-go#status>
- Node TypeScript execution: <https://nodejs.org/api/typescript.html>
- Node packages/ESM: <https://nodejs.org/api/packages.html>
- Node globals: <https://nodejs.org/api/globals.html#fetch>
- Node release schedule: <https://github.com/nodejs/Release/blob/main/schedule.json>
- Official OnTrack API source: <https://github.com/doubtfire-lms/doubtfire-api/tree/c91418e128e97df1fb61d0f774715475b757d8f4>
- Official OnTrack web source: <https://github.com/doubtfire-lms/doubtfire-web/tree/dc5fc3633b1d4a13518ae412cd9219f2787326a2>
- npm registry, conflicting unscoped package: <https://registry.npmjs.org/ontrack-cli/latest>
- npm registry, candidate scoped package: <https://registry.npmjs.org/%40bunizao%2Fontrack-cli>
