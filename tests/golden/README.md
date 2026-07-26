# Command golden corpus

Each command case contains JSON `argv`, JSON `env`, `source.json`, exact `stdout.json`, exact `stderr.txt`, and `exit` files. Run `npm run test:golden:update` to regenerate outputs; do not edit expected output files by hand.

Case `source.json` files name a source under `sources/`. A source is either:

- `synthetic`: deliberately invented, non-live data with `live_recorded: false`; or
- `python_oracle`: a sanitized capture made by the final Python recorder at commit `06e0c4b6d45cdda4e999e4c829d61bfe8392ef8c`, with recording time and capture digest.

The current corpus is synthetic because the available Okta session cannot authenticate the Python oracle. Synthetic data must never be presented as live-recorded parity evidence.

After a successful authenticated capture, import its JSONL only with an explicit provenance acknowledgement:

```sh
node scripts/golden-import-oracle.mjs capture.jsonl oracle-YYYY-MM-DD 2026-07-26T12:00:00Z --confirm-live-recorded
```
