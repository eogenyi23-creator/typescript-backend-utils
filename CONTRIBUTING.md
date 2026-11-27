# Contributing to typescript-backend-utils

Thank you for taking the time to contribute.

This project provides TypeScript utilities for Stellar and Soroban backend development. Because it is a toolkit rather than a monolithic framework, each module in `src/` is kept standalone with its own tests.

---

## Local Development Setup

### Prerequisites
- **Node.js** 20 or 22 (the CI-tested versions)
- **npm** or **pnpm**
- **Redis** (optional — only needed for `REDIS_URL=redis://localhost:6379 npm run test:integration`)

### Installation and build

1. Fork and clone:
   ```bash
   git clone https://github.com/eogenyi23-creator/typescript-backend-utils
   cd typescript-backend-utils
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Verify the build:
   ```bash
   npm run build
   ```

---

## Code quality

### Type check and lint

```bash
npm run lint
```

This runs `tsc --noEmit` over `src/`. There is no separate ESLint config.

### Unit tests

```bash
npm test
```

Runs all tests in `tests/` except `tests/integration/`. No Redis required.

```bash
npm run test:coverage
```

Same, with a coverage report.

### Integration tests (Redis required)

```bash
REDIS_URL=redis://localhost:6379 npm run test:integration
```

The integration tests in `tests/integration/redis.test.ts` are skipped with a clear message when `REDIS_URL` is not set.

### Type-check examples

```bash
npm run check:examples
```

Runs `tsc --noEmit` over `examples/` using `tsconfig.examples.json`.

### Verify README snippets match example files

```bash
npm run check:readme-examples
```

### Verify claims audit

```bash
npm run check:claims
```

Checks that every `test-backed` row in `docs/claims-audit.md` names a test file and
test title that actually exist in `tests/`.

---

## Architecture principles

1. **Standalone modules:** each file in `src/` works without importing from the others.
2. **Peer dependencies:** `ioredis` and `@stellar/stellar-sdk` stay as `peerDependencies` so consumers are not forced to include them if they use only some modules.
3. **Configurable:** pass server instances, Redis clients, and options in constructors — no hidden global state.

---

## Pull request process

1. Create a focused branch from `main`.
2. Add or update tests for any behaviour change.
3. Run the full check sequence before opening a PR:
   ```bash
   npm run lint
   npm run build
   npm test
   npm run check:examples
   npm run check:readme-examples
   npm run check:claims
   ```
4. Open a PR targeting `main` and ensure CI passes.

---

## Security vulnerabilities

Do not report security vulnerabilities via public GitHub issues. See [SECURITY.md](SECURITY.md) for the reporting process.
