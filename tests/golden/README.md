# Command golden corpus

Each command case contains JSON `argv`, JSON `env`, `source.json`, exact `stdout.json`, exact `stderr.txt`, and `exit` files. Run `npm run test:golden:update` to regenerate synthetic outputs. Cases backed by the Python oracle are locked. Do not edit expected output files by hand.

Case `source.json` files name a source under `sources/`. A source is either:

- `synthetic`: deliberately invented, non-live data with `live_recorded: false`; or
- `python_oracle`: a sanitized capture made by the final Python release pinned in [`oracle-provenance.json`](./oracle-provenance.json), with recording time and capture digest.

The representative success corpus is bound to `oracle-2026-07-27`, an authenticated sanitized capture with reproducible Python command replays. The capture and replay pipeline was used only for the TypeScript cutover and is intentionally not part of the maintained tooling. Nonrepresentative edge and failure cases remain synthetic and must not be presented as live-recorded parity evidence.

For `user`, `auth check`, `projects`, and `roles`, the complete parsed JSON remains the parity projection. For `project` and `tasks`, truly new schedule and timeout keys are removed. Existing corrected keys keep their presence and insertion position while their values are normalized, so a missing or reordered surviving key still fails. Only the derived task-list order is normalized because corrected schedule precedence can reorder rows. Python stdout must already use the standard pretty JSON format and trailing newline.

`verify:oracle` validates the recorded Python commit, fixture and session hashes, historical replay harness, argv, environment allowlist, exit status, stderr digest, stdout digest, and deterministic projection. It requires reproducible replay evidence for nine representative cases covering all six retained commands plus `--include-inactive`, `--status`, and `--all`. Minimal, empty, unknown-status, and error cases remain synthetic because they are not claims about the captured live state.

`verify:oracle` is the merge gate for the authenticated capture and all nine representative command replays. It must remain green; synthetic fixtures must never be relabelled as live evidence.
