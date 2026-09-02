# Contributing to soroban-ts-sdk

Thank you for your interest in contributing! This SDK is part of the Stellar open-source ecosystem and welcomes contributions of all kinds — bug fixes, new features, documentation improvements, and tests.

## Stellar Wave Program

This repository participates in the **[Stellar Wave Program](https://www.drips.network/wave)** on Drips. Contributors earn Points (redeemable for XLM rewards) for pull requests merged on eligible open issues.

To participate:
1. Browse [open issues](../../issues) — Wave-eligible issues are labelled `Stellar Wave`.
2. Apply to an issue on [drips.network/wave](https://www.drips.network/wave).
3. Once assigned, open a PR and get it merged before the Wave deadline.

See the [Drips Wave contributor guide](https://docs.drips.network/wave/contributors/solving-issues-and-earning-rewards) for full details.

## Getting Started

1. **Fork** the repository and clone your fork:
   ```bash
   git clone https://github.com/<your-username>/typescript-backend-utils
   cd typescript-backend-utils
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build:**
   ```bash
   npm run build
   ```

4. **Run tests:**
   ```bash
   npm test
   ```

## How to Contribute

### Picking an Issue

- Browse [open issues](../../issues) for tasks to work on.
- Issues labelled [`good first issue`](../../issues?q=label%3A%22good+first+issue%22) are beginner-friendly.
- Issues labelled [`help wanted`](../../issues?q=label%3A%22help+wanted%22) are higher-priority.
- Issues labelled `Stellar Wave` are eligible for Wave Program rewards.
- Comment on an issue before starting work to avoid duplication.

### Branch Naming

Use descriptive branch names:
- `feat/horizon-sse-consumer` — new feature
- `fix/cache-ttl-boundary` — bug fix
- `docs/wasm-validate-example` — documentation

### Code Style

- TypeScript strict mode is enabled (`"strict": true` in tsconfig).
- No `any` — use proper types or `unknown` with type guards.
- All public functions and classes must have JSDoc comments.
- Follow the existing module pattern: pure functions + optional OO wrapper class.
- Each module is framework-agnostic — don't import Express, Fastify, or other frameworks in `src/`.

### Tests

- All new functionality must include tests in `tests/`.
- Tests should use Jest and follow the existing `describe`/`it` structure.
- Mock external dependencies (Redis, RPC nodes) — no live services in tests.
- Run `npm test` before submitting. All tests must pass.
- Run `npm run lint` — no TypeScript errors allowed.

### Pull Request Process

1. Make sure `npm run build` and `npm test` both pass locally.
2. Keep your PR focused — one feature or fix per PR.
3. Write a clear PR description explaining what changed and why.
4. Reference the issue your PR resolves: `Closes #<issue-number>`.
5. Be responsive to review feedback — Wave PRs have a deadline.

## Module Overview

| File | Responsibility |
|------|---------------|
| `src/contractCache.ts` | Ledger-sequence-aware LRU+Redis cache. Core TTL logic lives in `_toWallClockTtl` and `_checkLiveness`. |
| `src/rpcRateLimiter.ts` | Token-bucket via atomic Lua in Redis. IP resolution in `resolveIdentifier`. |
| `src/transactionBatcher.ts` | Concurrency via semaphore pattern in `_executeBatch`. Retry in `_executeTask`. |
| `src/horizonEventHandler.ts` | HMAC verification, replay prevention, idempotency, queue offload. |
| `src/wasmPipeline.ts` | Streaming SHA-256 + gzip, magic byte check, manifest JSON output. |

## Stellar / Soroban Context

If you're new to Stellar development, these resources will help:

- [Stellar Developer Docs](https://developers.stellar.org)
- [Soroban Smart Contracts](https://developers.stellar.org/docs/smart-contracts)
- [Stellar JS SDK](https://github.com/stellar/js-stellar-sdk)
- [Soroban RPC API](https://developers.stellar.org/docs/data/rpc)
- [Horizon API](https://developers.stellar.org/api/horizon)

## Code of Conduct

Be respectful and constructive. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
