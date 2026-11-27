# typescript-backend-utils

> TypeScript utilities for Stellar/Soroban backends: contract state cache, RPC rate limiter, transaction batcher, Horizon event handler, WASM pipeline. Tested on testnet.

[![CI](https://github.com/eogenyi23-creator/typescript-backend-utils/actions/workflows/ci.yml/badge.svg)](https://github.com/eogenyi23-creator/typescript-backend-utils/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/eogenyi23-creator/typescript-backend-utils/blob/main/LICENSE) [![Stellar](https://img.shields.io/badge/Stellar-Soroban-blue)](https://developers.stellar.org/docs/smart-contracts)

## Names

- **GitHub repository:** `typescript-backend-utils` (the repo name is kept to avoid breaking existing URLs)
- **npm package:** `soroban-ts-sdk` — not yet confirmed as published on npm (checked 2026-11-27: `npm view soroban-ts-sdk` returned 404)
- **TypeScript import:** `import { ... } from 'soroban-ts-sdk'`

## Why this exists

Every backend talking to Stellar/Soroban eventually hits the same five problems, usually in this order:

1. Your RPC node starts rate-limiting you because you're calling `getContractData` on a loop.
2. You add a cache, and now you have stale-data bugs.
3. You need to submit a batch of transactions and some inevitably fail, so you write retry logic — badly, under deadline pressure.
4. You wire up a Horizon event stream and get bitten by a duplicate event on reconnect.
5. You deploy a contract and realize you never actually verified the WASM you're uploading matches what you built.

Most teams solve each of these individually, inside their own app — which means the retry logic, the cache invalidation, and the idempotency checks are all under-tested and never looked at again. This package pulls those five problems out into small, independently-tested modules, so you can pick the ones you need instead of writing your own version of each.

**This is a toolkit, not a framework.** Each module works standalone. Import what you need.

## What is typescript-backend-utils?

Building on Stellar means wiring together RPC calls, Soroban contract reads, Horizon event streams, and WASM deployments. The plumbing is repetitive — this SDK packages it into tested TypeScript modules so you can focus on your contract logic.

| Module | Description |
| --- | --- |
| [`contractCache`](https://github.com/eogenyi23-creator/typescript-backend-utils/blob/main/src/contractCache.ts) | Two-tier LRU + Redis cache for Soroban contract state reads |
| [`rpcRateLimiter`](https://github.com/eogenyi23-creator/typescript-backend-utils/blob/main/src/rpcRateLimiter.ts) | Token-bucket rate limiter for Stellar RPC / Horizon API calls |
| [`transactionBatcher`](https://github.com/eogenyi23-creator/typescript-backend-utils/blob/main/src/transactionBatcher.ts) | Concurrent Soroban transaction submission with exponential backoff |
| [`horizonEventHandler`](https://github.com/eogenyi23-creator/typescript-backend-utils/blob/main/src/horizonEventHandler.ts) | HMAC-verified handler for relay-delivered Horizon event callbacks |
| [`wasmPipeline`](https://github.com/eogenyi23-creator/typescript-backend-utils/blob/main/src/wasmPipeline.ts) | Streaming WASM validation and hash pipeline for Soroban contract uploads |

## Verified against Stellar testnet

On 2026-11-27 the full testnet harness (`npm run testnet` with Redis on
localhost, after `npm run testnet:preflight`) was run end to end on `main`
(merge commit of PR #33): **18 checks, 18 passed, 0 failed, 0 skipped**.

- Deployed contract (this repo's `kv-test` fixture):
  `CBKCMVFQZE7X6QA4VKAWE3IKBYUJBEBTTSGZY7BWQG3WFW52JC5UMZLQ`
  — [contract explorer](https://stellar.expert/explorer/testnet/contract/CBKCMVFQZE7X6QA4VKAWE3IKBYUJBEBTTSGZY7BWQG3WFW52JC5UMZLQ)
- WASM hash (from the real upload):
  `cf46518c3c6cc678788e52340431638a21d56c1c42822dc2643f1af0e4f10391`
- Re-confirmed transactions (SUCCESS via `getTransaction`):
  [`17c8939d…31f29`](https://stellar.expert/explorer/testnet/tx/17c8939d8f1d29755692d225ac2fe3f97386260105625fe67864b22386831f29)
  and
  [`8a6b1743…b95f`](https://stellar.expert/explorer/testnet/tx/8a6b1743625d622cb681628eafe1239c4ad7b0f4515b3dbe6d656dba8f0fb95f)

**What ran where:**

- **Against the testnet** (through the deployed contract): the WasmPipeline
  upload-hash check (A), the ContractCache checks (B) and the
  TransactionBatcher checks (C).
- **Against a local Redis** (not Stellar's own RPC limits): the RpcRateLimiter
  checks (D) against a real local Redis 7.0.15.
- **Locally over HTTP only** (no testnet, no relay): the HorizonEventHandler
  checks (E).

**Limits of this run:** mainnet; load or long-running behaviour; Stellar's
real RPC rate-limit enforcement; Horizon streaming (SSE) and any real relay
service; contract TTL expiry; Redis Cluster; `@stellar/stellar-sdk` versions
other than the tested 13.1.0. Transactions in the batcher check were sent
through the `stellar` CLI (the batcher's concurrency, retry and
failure-isolation logic ran; transaction building is the CLI's). The test
contract is a minimal fixture. No security audit. Full details in
[`docs/testnet-run.md`](docs/testnet-run.md).

**Reproduce:**

```bash
npm run testnet:preflight
REDIS_URL=redis://localhost:6379 npm run testnet
```

Prerequisites (stellar CLI, Rust/wasm target, Redis) are listed in
[`docs/testnet.md`](docs/testnet.md).

## Installation

The package `soroban-ts-sdk` is **not confirmed as published** on the npm registry (checked 2026-11-27: `npm view soroban-ts-sdk` returns 404). Install directly from GitHub:

```bash
npm install github:eogenyi23-creator/typescript-backend-utils
```

If the package is published to npm in the future, the install command will be:

```bash
# once published:
# npm install soroban-ts-sdk
```

**Peer dependencies** (install separately based on what you use):

```bash
npm install @stellar/stellar-sdk ioredis
```

**SDK version:** tested with `@stellar/stellar-sdk@13.1.0`. The declared peer dependency range is `>=12.0.0`; older and newer versions are untested.

**Node.js:** tested on Node 20.x and 22.x (the CI matrix). Node 20+ is required; other versions are untested.

## Quick Start

### Contract State Cache

Avoid hammering your RPC node with repeated `getContractData` calls on the same key.
`getOrFetch` takes a `{ contractId, storageKey }` object and a fetch callback that
returns a `SorobanEntryResult` with the `liveUntilLedgerSeq` and `durability` fields
from the RPC response:

<!-- example: contract-cache -->
```typescript
import { ContractCache } from 'soroban-ts-sdk';
import { rpc } from '@stellar/stellar-sdk';

const server = new rpc.Server('https://soroban-testnet.stellar.org');
const cache = new ContractCache({ maxSize: 500 });

const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const userAddress = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

const balance = await cache.getOrFetch(
  { contractId, storageKey: `balance:${userAddress}` },
  async () => {
    const latestLedger = await server.getLatestLedger();
    return {
      value: { amount: 0 },
      liveUntilLedgerSeq: latestLedger.sequence + 100,
      durability: 'persistent' as const,
      fetchedAtLedger: latestLedger.sequence,
    };
  }
);

void balance;
```

### RPC Rate Limiter

Respect Stellar RPC and Horizon rate limits without dropping requests.
`RpcRateLimiter.create` takes the endpoint name, a Redis client, a tier string
(`'public'` or `'authenticated'`), and an optional config override:

<!-- example: rpc-rate-limiter -->
```typescript
import { RpcRateLimiter } from 'soroban-ts-sdk';
import { Redis } from 'ioredis';

const redis = new Redis();
const limiter = RpcRateLimiter.create('soroban-rpc', redis, 'public', {
  maxTokens: 100,
  refillRate: 100 / 60,
  windowSeconds: 60,
});

// app.use('/rpc', limiter.middleware());
void limiter;
```

### Transaction Batcher

Submit multiple Soroban transactions concurrently with automatic retry.
Each task is a zero-argument async function. Use `submitWithResults` to get
typed `fulfilled` and `rejected` buckets:

<!-- example: transaction-batcher -->
```typescript
import { TransactionBatcher } from 'soroban-ts-sdk';
import type { rpc } from '@stellar/stellar-sdk';

const batcher = new TransactionBatcher<rpc.Api.SendTransactionResponse>({
  maxConcurrency: 5,
  batchSize: 10,
  retryInterval: 1000,
  maxRetries: 3,
});

// Each task is a zero-argument async function that submits one transaction.
const tasks: Array<() => Promise<rpc.Api.SendTransactionResponse>> = [];

const { fulfilled, rejected } = await batcher.submitWithResults(tasks);

fulfilled.forEach((r) => {
  console.log('hash:', r.result.hash);
});
rejected.forEach((r) => {
  console.error('failed:', r.error.message);
});
```

### Horizon Event Handler

Verify and deduplicate HMAC-signed HTTP callbacks that deliver Horizon event data.
The handler checks the `x-stellar-signature` header (HMAC-SHA256), rejects payloads
older than `maxAgeSeconds` (default 300 s), and deduplicates by event ID.
Horizon itself does not send webhooks; this handler is for use with a relay service
that you operate or choose:

<!-- example: horizon-event-handler -->
```typescript
import { HorizonEventHandler } from 'soroban-ts-sdk';

const handler = HorizonEventHandler.create({
  secret: process.env['HORIZON_WEBHOOK_SECRET'] ?? 'dev-secret',
  onEvent: async (event) => {
    if (event.type === 'payment') {
      console.log('processing payment:', event.id);
    }
  },
});

// app.post('/horizon/events', handler.middleware());
void handler;
```

### WASM Upload Pipeline

Hash, validate, and prepare a Soroban contract WASM before deploying:

<!-- example: wasm-pipeline -->
```typescript
import { WasmPipeline } from 'soroban-ts-sdk';

const pipeline = new WasmPipeline({ sandboxDir: './contracts/target' });

const result = await pipeline.process('my_contract.wasm');
console.log('SHA-256:', result.sha256);
console.log('Size:   ', result.totalBytes, 'bytes');
console.log('Valid:  ', result.integrityVerified);
```

## Repository Structure

```
typescript-backend-utils/
├── src/
│   ├── contractCache.ts        # Soroban contract state LRU+Redis cache
│   ├── rpcRateLimiter.ts       # Token-bucket rate limiter for RPC/Horizon
│   ├── transactionBatcher.ts   # Concurrent transaction submission + retry
│   ├── horizonEventHandler.ts  # HMAC-verified Horizon event callback handler
│   ├── wasmPipeline.ts         # WASM streaming hash + validation pipeline
│   └── index.ts                # Barrel export
├── examples/
│   ├── contract-cache.ts
│   ├── rpc-rate-limiter.ts
│   ├── transaction-batcher.ts
│   ├── horizon-event-handler.ts
│   └── wasm-pipeline.ts
├── tests/
│   ├── contractCache.test.ts
│   ├── rpcRateLimiter.test.ts
│   ├── transactionBatcher.test.ts
│   ├── horizonEventHandler.test.ts
│   ├── wasmPipeline.test.ts
│   └── integration/
│       └── redis.test.ts       # Requires REDIS_URL; skipped otherwise
├── docs/
│   └── claims-audit.md         # Factual claims mapped to code and tests
├── .github/workflows/
│   └── ci.yml                  # Build, test, and integration test on every push/PR
├── package.json
├── tsconfig.json
├── tsconfig.examples.json
├── CONTRIBUTING.md
└── SECURITY.md
```

## Development

### Prerequisites

- Node.js 20 or 22 (the CI-tested versions)
- npm / pnpm / yarn
- Redis (optional — only needed for the integration tests)

### Setup

```bash
git clone https://github.com/eogenyi23-creator/typescript-backend-utils
cd typescript-backend-utils
npm install
```

### Build

```bash
npm run build
```

### Test

```bash
# Unit tests (no Redis required):
npm test

# With coverage:
npm run test:coverage

# Integration tests (requires Redis):
REDIS_URL=redis://localhost:6379 npm run test:integration
```

### Type-check examples

```bash
npm run check:examples
```

### Check README examples match example files

```bash
npm run check:readme-examples
```

### Lint

```bash
npm run lint
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](https://github.com/eogenyi23-creator/typescript-backend-utils/blob/main/CONTRIBUTING.md) for guidelines.

## Stellar Resources

- [Soroban Documentation](https://developers.stellar.org/docs/smart-contracts)
- [Stellar SDK for JS](https://github.com/stellar/js-stellar-sdk)
- [Soroban RPC Reference](https://developers.stellar.org/docs/data/rpc)
- [Horizon API Reference](https://developers.stellar.org/api/horizon)

## License

MIT — see [LICENSE](https://github.com/eogenyi23-creator/typescript-backend-utils/blob/main/LICENSE).
