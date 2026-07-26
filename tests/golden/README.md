# Command golden corpus

Each command case contains JSON `argv`, JSON `env`, `source.json`, exact `stdout.json`, exact `stderr.txt`, and `exit` files. Run `npm run test:golden:update` to regenerate outputs; do not edit expected output files by hand.

Case `source.json` files name a source under `sources/`. A source is either:

- `synthetic`: deliberately invented, non-live data with `live_recorded: false`; or
- `python_oracle`: a sanitized capture made by the final Python release pinned in [`oracle-provenance.json`](./oracle-provenance.json), with recording time and capture digest.

The current corpus is synthetic because the available Okta session cannot authenticate the Python oracle. Synthetic data must never be presented as live-recorded parity evidence.

Capture every required route through one Python process so the first-seen identifier pseudonyms remain stable across project, unit, task, and role responses. The helper selects the first current project as pseudonym `1`, rejects an existing destination, and records each route exactly once:

```sh
/path/to/python-v0.1.3/.venv/bin/python -m ontrack_cli.oracle_capture /secure/tmp/capture.jsonl
```

Do not build the fixture by appending output from separate CLI processes. After a successful authenticated capture, import its JSONL only with an explicit provenance acknowledgement:

```sh
node scripts/golden-import-oracle.mjs capture.jsonl oracle-YYYY-MM-DD 2026-07-26T12:00:00Z --confirm-live-recorded
node scripts/golden-bind-oracle-source.mjs oracle-YYYY-MM-DD --confirm-bind-live-oracle
npm run test:golden:update
npm run test:golden
```

Binding happens before replay because the TypeScript golden must be generated from the same sanitized live fixture. The command-output importer then compares Python against those fixture-derived TypeScript bytes, never against the unrelated synthetic placeholder corpus.

The HTTP capture alone is not command parity evidence. Replay the sanitized fixture through the clean, pinned Python checkout. The runner injects a fail-closed `requests` adapter, rejects every unrecorded request before network access, and writes stdout, stderr, exit, and replay provenance separately:

```sh
node scripts/golden-replay-python.mjs \
  --python /path/to/python-v0.1.3/.venv/bin/python \
  --python-checkout /path/to/python-v0.1.3 \
  --tool-checkout /path/to/clean/ontrack-cli \
  --entrypoint ontrack_cli.cli \
  --fixture tests/golden/sources/oracle-YYYY-MM-DD/http.json \
  --session tests/golden/sources/oracle-YYYY-MM-DD/session.json \
  --env tests/golden/projects/current-json/env \
  --stdout /secure/tmp/stdout.json \
  --stderr /secure/tmp/stderr.txt \
  --exit /secure/tmp/exit \
  --provenance /secure/tmp/provenance.json \
  -- projects --json

node scripts/golden-import-command-output.mjs \
  /secure/tmp/stdout.json \
  --replay-provenance /secure/tmp/provenance.json \
  oracle-YYYY-MM-DD projects/current-json 2026-07-26T12:01:00Z \
  --confirm-reproducible-python-replay
npm run verify:oracle
```

For `user`, `auth check`, `projects`, and `roles`, the complete parsed JSON remains the parity projection. For `project` and `tasks`, truly new schedule and timeout keys are removed. Existing corrected keys keep their presence and insertion position while their values are normalized, so a missing or reordered surviving key still fails. Only the derived task-list order is normalized because corrected schedule precedence can reorder rows. Python stdout must already use the standard pretty JSON format and trailing newline.

The importer validates the replay's Python commit, entrypoint, fixture and session hashes, committed replay harness hash, argv, environment allowlist, exit status, stderr digest, and stdout digest before rebinding the case. After schema-aware placeholder validation, it stores the sanitized replay stdout, deterministic projection, and full safe replay provenance. This lets `verify:oracle` recompute the stdout hash and projection instead of trusting a hand-written digest. `verify:oracle` requires reproducible replay evidence for nine representative cases covering all six retained commands plus `--include-inactive`, `--status`, and `--all`. Minimal, empty, unknown-status, and error cases remain synthetic because they are not claims about the captured live state.

The available Monash session currently lacks the OnTrack `username` and `refresh_token` cookies required for authenticated capture. Until a sanitized authenticated fixture is captured and all cases are replayed from it, `verify:oracle` intentionally remains red; synthetic fixtures must not be relabelled as live evidence.
