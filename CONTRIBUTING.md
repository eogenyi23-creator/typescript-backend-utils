Contributing to typescript-backend-utils

Thank you for your interest in contributing! This SDK is part of the Stellar open-source ecosystem and welcomes contributions of all kinds — bug fixes, new features, documentation improvements, and tests.


Stellar Wave Program

This repository has been submitted for inclusion in the Stellar Wave Program on Drips and is currently pending review. It is not yet an accepted Wave repository, and issues are not yet eligible for Points or XLM rewards.


Once (and if) the repo is accepted, this section will be updated with confirmed eligibility details and any Stellar Wave-labeled issues. Until then, please don't rely on Wave rewards for contributions here — treat this as a standard open-source contribution.


If you'd like to check current status, see the Drips Wave contributor guide.


Getting Started


Fork the repository and clone your fork:

git clone https://github.com/<your-username>/typescript-backend-utils
cd typescript-backend-utils

Install dependencies:

npm install

Build:

npm run build

Run tests:

npm test


How to Contribute

Picking an Issue


Browse open issues for tasks to work on.

Issues labelled good first issue are beginner-friendly.

Issues labelled help wanted are higher-priority.

Comment on an issue before starting work to avoid duplication.


Branch Naming

Use descriptive branch names:



feat/horizon-sse-consumer — new feature

fix/cache-ttl-boundary — bug fix

docs/wasm-validate-example — documentation


Code Style


TypeScript strict mode is enabled ("strict": true in tsconfig).

No any — use proper types or unknown with type guards.

All public functions and classes must have JSDoc comments.

Follow the existing module pattern: pure functions + optional OO wrapper class.

Each module is framework-agnostic — don't import Express, Fastify, or other frameworks in src/.


Tests


All new functionality must include tests in tests/.

Tests should use Jest and follow the existing describe/it structure.

Mock external dependencies (Redis, RPC nodes) — no live services in tests.

Run npm test before submitting. All tests must pass.

Run npm run lint — no TypeScript errors allowed.


Pull Request Process


Make sure npm run build and npm test both pass locally.

Keep your PR focused — one feature or fix per PR.

Write a clear PR description explaining what changed and why.

Reference the issue your PR resolves: Closes #<issue-number>.

Be responsive to review feedback.


Module Overview

File	Responsibility
src/contractCache.ts	Ledger-sequence-aware LRU+Redis cache. Core TTL logic lives in _toWallClockTtl and _checkLiveness.
src/rpcRateLimiter.ts	Token-bucket via atomic Lua in Redis. IP resolution in resolveIdentifier.
src/transactionBatcher.ts	Concurrency via semaphore pattern in _executeBatch. Retry in _executeTask.
src/horizonEventHandler.ts	HMAC verification, replay prevention, idempotency, queue offload.
src/wasmPipeline.ts	Streaming SHA-256 + gzip, magic byte check, manifest JSON output.

Stellar / Soroban Context

If you're new to Stellar development, these resources will help:



Stellar Developer Docs

Soroban Smart Contracts

Stellar JS SDK

Soroban RPC API

Horizon API


Code of Conduct

Be respectful and constructive. We follow the Contributor Covenant.


License

By contributing, you agree that your contributions will be licensed under the MIT License.

