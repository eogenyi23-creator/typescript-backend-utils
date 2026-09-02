# soroban-ts-sdk

> A TypeScript utility SDK for Stellar and Soroban developers — production-ready building blocks for dApps, indexers, and contract tooling.

[![CI](https://github.com/eogenyi23-creator/typescript-backend-utils/actions/workflows/ci.yml/badge.svg)](https://github.com/eogenyi23-creator/typescript-backend-utils/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-blue)](https://developers.stellar.org/docs/smart-contracts)

## What is soroban-ts-sdk?

Building on Stellar means wiring together RPC calls, Soroban contract reads, Horizon event streams, and WASM deployments. The plumbing is repetitive — this SDK packages it into well-tested, composable TypeScript modules so you can focus on your contract logic.

| Module | Description |
|--------|-------------|
| [`contractCache`](src/contractCache.ts) | Ledger-sequence-aware two-tier LRU+Redis cache for Soroban contract state — expiry driven by `liveUntilLedgerSeq`, with distinct handling for archived persistent entries |
| [`rpcRateLimiter`](src/rpcRateLimiter.ts) | Token-bucket rate limiter (Redis-backed) for Stellar RPC / Horizon API calls, with `trustProxy` support |
| [`transactionBatcher`](src/transactionBatcher.ts) | Concurrent Soroban transaction submission with exponential backoff and `submitWithResults()` helper |
| [`horizonEventHandler`](src/horizonEventHandler.ts) | Secure, idempotent Horizon event handler with in-memory and Redis-backed deduplication |
| [`wasmPipeline`](src/wasmPipeline.ts) | Streaming WASM validation (`validate()`), hash, and manifest pipeline for Soroban contract uploads |

## Installation

```bash
npm install soroban-ts-sdk
# or
pnpm add soroban-ts-sdk
```

**Peer dependencies** (install separately based on what you use):

```bash
npm install @stellar/stellar-sdk ioredis
```

## Quick Start

### Contract State Cache

Caches Soroban `getLedgerEntries` results using the real on-chain TTL model.

Every Soroban CONTRACT_DATA entry has a `liveUntilLedgerSeq` field returned by the RPC — the last ledger at which the entry is live. This cache stores that value alongside each entry and checks it against the current network ledger on every read, so expiry is driven by ledger sequence rather than a wall-clock guess.

**Persistent vs temporary durability:**
- **Persistent** entries are archived (not deleted) when their TTL expires. Restoring them requires a `RestoreFootprintOperation`. The cache surfaces this as `{ entryArchived: true }` rather than a generic miss, so callers know a restore is needed before refetching.
- **Temporary** entries are permanently deleted on-chain when their TTL expires. The cache returns a plain `undefined` miss.

```typescript
import { ContractCache, LedgerSequenceTracker } from 'soroban-ts-sdk';
import { SorobanRpc, xdr, Address } from '@stellar/stellar-sdk';

const server = new SorobanRpc.Server('https://soroban-testnet.stellar.org');

// Tracks current ledger sequence, re-fetching at most once every 4 s
const tracker = new LedgerSequenceTracker(
  () => server.getLatestLedger().then(r => r.sequence)
);

const cache = new ContractCache({ maxSize: 500 }, null, tracker);

const ledgerKey = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: new Address(contractId).toScAddress(),
    key: xdr.ScVal.scvSymbol('balance'),
    durability: xdr.ContractDataDurability.persistent(),
  })
);

const result = await cache.getOrFetch(
  { contractId, storageKey: ledgerKey.toXDR('base64') },
  async () => {
    const resp = await server.getLedgerEntries(ledgerKey);
    const entry = resp.entries[0];
    return {
      value:               decodeBalanceScVal(entry.xdr),
      liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
      durability:         'persistent',
      fetchedAtLedger:    resp.latestLedger,
    };
  }
);

if (result.entryArchived) {
  // Entry has expired on-chain. Submit RestoreFootprintOperation, then retry.
  console.log('Entry archived at ledger', result.liveUntilLedgerSeq);
  await submitRestoreFootprint(contractId, ledgerKey);
} else {
  console.log('Balance:', result.value);
}
```

### RPC Rate Limiter

Token-bucket rate limiter backed by Redis. The `trustProxy` option lets you safely honour `X-Forwarded-For` headers when sitting behind a trusted reverse proxy.

```typescript
import { RpcRateLimiter } from 'soroban-ts-sdk';
import Redis from 'ioredis';

const redis = new Redis();

// Direct exposure — use socket IP only (safe default)
const limiter = RpcRateLimiter.create('soroban-rpc', redis);

// Behind a trusted reverse proxy (nginx, AWS ALB, Cloudflare, etc.)
const limiterWithProxy = RpcRateLimiter.create(
  'soroban-rpc', redis, 'public', {}, { trustProxy: true }
);

// In your Express/Hono middleware:
app.use('/rpc', limiter.middleware());
```

### Transaction Batcher

Submit multiple Soroban transactions concurrently with automatic retry on transient errors (`txInsufficientFee`, `txBadSeq`).

```typescript
import { TransactionBatcher } from 'soroban-ts-sdk';

const batcher = new TransactionBatcher({
  maxConcurrency: 5,
  batchSize: 10,
  retryInterval: 1000,
  maxRetries: 3,
});

const tasks = txEnvelopes.map(xdr => () => server.sendTransaction(xdr));

// Option A — flat array of records
const records = await batcher.run(tasks);

// Option B — typed split into fulfilled / rejected buckets
const { fulfilled, rejected } = await batcher.submitWithResults(tasks);
for (const r of fulfilled) console.log('hash:', r.result.hash);
for (const r of rejected)  console.error('error:', r.error.message);
```

### Horizon Event Handler

Process Stellar Horizon payment, ledger, and contract events with HMAC signature verification and idempotency.

```typescript
import { HorizonEventHandler, RedisIdempotencyStore } from 'soroban-ts-sdk';
import Redis from 'ioredis';

// Single-instance / dev — in-memory deduplication
const handler = HorizonEventHandler.create({
  secret: process.env.HORIZON_WEBHOOK_SECRET!,
  onEvent: async (event) => {
    if (event.type === 'payment') await processPayment(event);
  },
});

// Production — Redis-backed deduplication (survives restarts, works across instances)
const idempotency = new RedisIdempotencyStore(new Redis(), { ttlSeconds: 300 });
const handlerProd = HorizonEventHandler.create(
  { secret: process.env.HORIZON_WEBHOOK_SECRET! },
  idempotency
);

// Express route
app.post('/horizon/events', handler.middleware());
```

### WASM Upload Pipeline

Validate, hash, and prepare a Soroban contract WASM before uploading to the Stellar network.

```typescript
import { WasmPipeline } from 'soroban-ts-sdk';

const pipeline = new WasmPipeline({ sandboxDir: './contracts/target/wasm32v1-none/release' });

// Validate first — throws immediately if the file is not a valid WASM binary,
// preventing a wasted on-chain upload transaction.
await pipeline.validate('my_contract.wasm');

// Process — streams the file, computes SHA-256, writes a manifest JSON.
const manifest = await pipeline.process('my_contract.wasm');
console.log('wasm-hash:', manifest.sha256);   // use with `stellar contract install --wasm-hash`
console.log('size:     ', manifest.totalBytes, 'bytes');
console.log('valid:    ', manifest.wasmMagicValid && manifest.integrityVerified);
```

## Repository Structure

```
soroban-ts-sdk/
├── src/
│   ├── contractCache.ts        # Ledger-sequence-aware Soroban contract state cache
│   ├── rpcRateLimiter.ts       # Token-bucket rate limiter for RPC/Horizon
│   ├── transactionBatcher.ts   # Concurrent transaction submission + retry
│   ├── horizonEventHandler.ts  # Horizon streaming event handler
│   ├── wasmPipeline.ts         # WASM streaming hash + validation pipeline
│   └── index.ts                # Barrel export
├── tests/
│   ├── contractCache.test.ts
│   ├── rpcRateLimiter.test.ts
│   ├── transactionBatcher.test.ts
│   ├── horizonEventHandler.test.ts
│   └── wasmPipeline.test.ts
├── .github/workflows/
│   └── ci.yml                  # Build + test on every push/PR (Node 20 & 22)
├── package.json
├── tsconfig.json
├── CONTRIBUTING.md
└── SECURITY.md
```

## Development

### Prerequisites

- Node.js 20+
- npm / pnpm / yarn
- (Optional) Redis for rate limiter and cache tests

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
npm test
```

### Lint / Type-check

```bash
npm run lint
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines.

Open issues labelled [`good first issue`](../../issues?q=label%3A%22good+first+issue%22) are great starting points for first-time contributors. This repository participates in the [Stellar Wave Program](https://www.drips.network/wave) — contributors can earn rewards for merged PRs on open issues.

## Stellar Resources

- [Soroban Documentation](https://developers.stellar.org/docs/smart-contracts)
- [Stellar SDK for JS](https://github.com/stellar/js-stellar-sdk)
- [Soroban RPC Reference](https://developers.stellar.org/docs/data/rpc)
- [Horizon API Reference](https://developers.stellar.org/api/horizon)

## License

MIT — see [LICENSE](LICENSE).
