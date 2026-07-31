# Contributing

Thank you for improving `ontrack-cli`. Changes should remain small, testable, and compatible with both Node.js and Bun.

## Setup

Install Node.js 22.5 or newer, Bun 1.3.14 or newer, and the project dependencies:

```bash
npm ci
```

Build the CLI and run it from the checkout:

```bash
npm run build
node dist/cli.js --help
```

## Development workflow

Run the focused checks while working, then run the full suite before opening a pull request:

```bash
npm run typecheck
npm test
npm run test:bun
npm run verify:source
npm run verify:golden
npm run verify:oracle
npm run coverage:domain
node scripts/package-smoke.mjs
npm pack --dry-run
```

The same emitted ESM files must work under Node.js and Bun. Avoid runtime-specific APIs unless both runtimes support the behavior and the CI matrix covers it.

## Project layout

- `src/` contains the CLI, authentication, API client, domain rules, and rendering code.
- `tests/` contains TypeScript tests and the test harness.
- `tests/fixtures/` contains synthetic API payloads.
- `tests/golden/` contains command-level compatibility cases.
- `scripts/` contains build and verification tools used by package scripts or CI.

See [docs/architecture.md](docs/architecture.md) for the module boundaries.

## Compatibility and safety

- Keep successful JSON output machine-readable and write diagnostics to stderr.
- Validate upstream data before it enters the domain layer.
- Preserve unknown OnTrack status values and tolerate optional upstream fields.
- Never commit access tokens, refresh cookies, session files, captured identities, or deployment-specific data.
- Do not use real credentials or identities in fixtures. Use synthetic or sanitized data.
- Keep code comments in English and use Conventional Commits.

Pull requests should explain the user-visible behavior, compatibility impact, and checks that were run.
