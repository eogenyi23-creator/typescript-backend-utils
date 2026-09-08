# Typescript-backend-utils

> Production-ready TypeScript building blocks for the parts of Stellar/Soroban backend development that every serious project ends up rebuilding from scratch.

[![CI](https://github.com/eogenyi23-creator/typescript-backend-utils/actions/workflows/ci.yml/badge.svg)](https://github.com/eogenyi23-creator/typescript-backend-utils/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-blue)](https://developers.stellar.org/docs/smart-contracts)

## Why this exist?

Every backend talking to Stellar/Soroban eventually hits the same five problems, usually in this order:


1. Your RPC node starts rate-limiting you because you're calling getContractData on a loop.

2. You add a cache, and now you have stale-data bugs.

3. You need to submit a batch of transactions and some inevitably fail, so you write retry logic — badly, under deadline pressure.

4. You wire up a Horizon event stream and get bitten by a duplicate event on reconnect.

5. You deploy a contract and realize you never actually verified the WASM you're uploading matches what you built.

Most teams solve each of these in an afternoon, individually, inside their own app — which means the retry logic, the cache invalidation, and the idempotency checks are all under-tested and never looked at again. This package pulls those five problems out into small, independently-tested modules, so you can pick the ones you need instead of writing your own version of each.


| Module | Problem it solves |
|--------|-------------|
| [`contractCache`](src/contractCache.ts) | Stop re-fetching the same on-chain contract state on every request. Two-tier (in-memory LRU + Redis) cache with ledger-aware TTLs. |
| [`rpcRateLimiter`](src/rpcRateLimiter.ts) | Stop getting throttled by Stellar RPC/Horizon. Token-bucket limiter with blocking and non-blocking modes. |
| [`transactionBatcher`](src/transactionBatcher.ts) | Submit many Soroban transactions concurrently without silently losing failures. Bounded concurrency + exponential backoff. |
| [`horizonEventHandler`](src/horizonEventHandler.ts) | Process Horizon streaming events exactly once, even across reconnects. Signature verification + idempotency built in. |
| [`wasmPipeline`](src/wasmPipeline.ts) | Know that the WASM you're about to deploy is the WASM you actually built. Streaming hash + integrity check before upload. |

Each module has its own test file under tests/ — see Test Coverage below for what's actually verified.

## Installation

```bash
npm install soroban-ts-sdk
# or
pnpm add soroban-ts-sdk
```

**Peer dependencies are optional and only required for the modules you use:** 

```bash
npm install @stellar/stellar-sdk ioredis # required by all modules
npm install ioredis                # only if using contractCache or rpcRateLimiter with Redis
```

## Quick Start

Pick the module you need — full examples for each are in docs/ (see Documentation below). Minimal example:

```bash
import { RpcRateLimiter } from 'soroban-ts-sdk';

const limiter = RpcRateLimiter.create('soroban-rpc', redis, {
  maxTokens: 100,
  refillRate: 100 / 60,
  windowSeconds: 60,
});

```

## Test Coverage

This is a backend toolkit that other people's production traffic will run through, so test coverage is treated as a hard requirement, not a nice-to-have:

- **Unit tests** for every module's core logic (see `tests/*.test.ts`).
- **Simulated-time tests** for the rate limiter and cache TTL behavior — real clock time isn't used in tests, so they're deterministic and fast.
- **Idempotency tests** for the Horizon event handler, specifically covering duplicate-event-on-reconnect scenarios.

> Current coverage: run `npm run test:coverage` to generate the report locally. *(If you have real coverage numbers, put them here — a specific percentage is more convincing to a reviewer than "well tested.")*

## Documentation

- [Architecture overview](./docs/architecture.md) — how the modules relate (or don't) to each other
- [`contractCache` guide](./docs/contract-cache.md)
- [`rpcRateLimiter` guide](./docs/rpc-rate-limiter.md)
- [`transactionBatcher` guide](./docs/transaction-batcher.md)
- [`horizonEventHandler` guide](./docs/horizon-event-handler.md)
- [`wasmPipeline` guide](./docs/wasm-pipeline.md)

## Roadmap

- [ ] Publish to npm under a stable version (currently source-install only)
- [ ] Redis-backed variant of `transactionBatcher` for multi-process deployments
- [ ] Fastify middleware helpers alongside the existing Express/Hono ones

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). Issues tagged [`good first issue`](https://github.com/eogenyi23-creator/typescript-backend-utils/issues?q=label%3A%22good+first+issue%22) are a good place to start, especially if you want to add a new middleware adapter or extend test coverage for edge cases.

## Security

See [SECURITY.md](./SECURITY.md) for how to report a vulnerability.

## License

MIT — see [LICENSE](./LICENSE). 


