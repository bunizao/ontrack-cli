# Command golden corpus

Each command case contains JSON `argv`, JSON `env`, `source.json`, exact `stdout.json`, exact `stderr.txt`, and `exit` files. Run `npm run test:golden:update` to regenerate outputs; do not edit expected output files by hand.

Case `source.json` files name a source under `sources/`. A source is either:

- `synthetic`: deliberately invented, non-live data with `live_recorded: false`; or
- `python_oracle`: a sanitized capture made by the final Python release pinned in [`oracle-provenance.json`](./oracle-provenance.json), with recording time and capture digest.

The current corpus is synthetic because the available Okta session cannot authenticate the Python oracle. Synthetic data must never be presented as live-recorded parity evidence.

After a successful authenticated capture, import its JSONL only with an explicit provenance acknowledgement:

```sh
node scripts/golden-import-oracle.mjs capture.jsonl oracle-YYYY-MM-DD 2026-07-26T12:00:00Z --confirm-live-recorded
```

The HTTP capture alone is not command parity evidence. The command-output input must come from replaying the sanitized HTTP fixture through the final Python CLI, not from raw live stdout. Bind those replayed bytes to an existing L2 case:

```sh
node scripts/golden-import-command-output.mjs python-stdout.json oracle-YYYY-MM-DD projects/current-json 2026-07-26T12:01:00Z --confirm-sanitized-python-output
npm run verify:oracle
```

The importer accepts Python stdout only when it matches the already-committed synthetic golden byte for byte. It then safely rebinds that case to the oracle source and records the command argv, environment, source HTTP digest, exact stdout bytes, and their digest. It also writes matching references into both the oracle source metadata and the case `source.json`. `verify:oracle` requires Python proof for every successful JSON case in the 18-case matrix, so all six retained commands and the representative `--include-inactive`, `--status`, and `--all` flag cases are covered. It also rejects an unreferenced artifact, an oracle-backed case without Python output, a Python source with no command outputs, or any later difference between the imported bytes and the committed golden.

The repository does not yet provide the sanitized-fixture replay generator. Until that exists and authenticated fixtures are captured, `verify:oracle` intentionally remains red; this proof-chain implementation is not a claim that live parity is complete.
