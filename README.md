# soroban-ts-sdk

> A TypeScript utility SDK for Stellar and Soroban developers — production-ready building blocks for dApps, indexers, and contract tooling.

[![CI](https://github.com/eogenyi23-creator/typescript-backend-utils/actions/workflows/ci.yml/badge.svg)](https://github.com/eogenyi23-creator/typescript-backend-utils/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stellar](https://img.shields.io/badge/Stellar-Soroban-blue)](https://developers.stellar.org/docs/smart-contracts)

## What is soroban-ts-sdk?

Building on Stellar means wiring together RPC calls, Soroban contract reads, Horizon event streams, and WASM deployments. The plumbing is repetitive — this SDK packages it into well-tested, composable TypeScript modules so you can focus on your contract logic.

| Module | Description |
|--------|-------------|
| [`contractCache`](src/contractCache.ts) | Two-tier LRU + Redis cache for Soroban contract state reads |
| [`rpcRateLimiter`](src/rpcRateLimiter.ts) | Token-bucket rate limiter for Stellar RPC / Horizon API calls |
| [`transactionBatcher`](src/transactionBatcher.ts) | Concurrent Soroban transaction submission with exponential backoff |
| [`horizonEventHandler`](src/horizonEventHandler.ts) | Secure, idempotent handler for Horizon streaming events |
| [`wasmPipeline`](src/wasmPipeline.ts) | Streaming WASM validation and hash pipeline for Soroban contract uploads |

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

Avoid hammering your RPC node with repeated `getContractData` calls on the same key:

```typescript
import { ContractCache } from 'soroban-ts-sdk';
import { Contract, SorobanRpc } from '@stellar/stellar-sdk';

const server = new SorobanRpc.Server('https://soroban-testnet.stellar.org');
const cache = new ContractCache({ maxSize: 500, defaultTtlLedgers: 5 });

// Cache miss: fetches from RPC. Cache hit: returns instantly.
const balance = await cache.getOrFetch(
  contractId,
  'balance',
  [new Address(userAddress)],
  (key) => server.getContractData(contractId, key, SorobanRpc.Durability.Persistent)
);
```

### RPC Rate Limiter

Respect Stellar RPC and Horizon rate limits without dropping requests:

```typescript
import { RpcRateLimiter } from 'soroban-ts-sdk';
import Redis from 'ioredis';

const redis = new Redis();
const limiter = RpcRateLimiter.create('soroban-rpc', redis, {
  maxTokens: 100,    // 100 req/min
  refillRate: 100 / 60,
  windowSeconds: 60,
});

// In your Express/Hono middleware:
app.use('/rpc', limiter.middleware());
```

### Transaction Batcher

Submit multiple Soroban transactions concurrently with automatic retry:

```typescript
import { TransactionBatcher } from 'soroban-ts-sdk';

const batcher = new TransactionBatcher({
  maxConcurrency: 5,
  batchSize: 10,
  retryInterval: 1000,
  maxRetries: 3,
});

const txEnvelopes = [...]; // array of XDR strings or Transaction objects
const results = await batcher.submit(txEnvelopes, (xdr) =>
  server.sendTransaction(xdr)
);

results.forEach((r) => {
  if (r.status === 'fulfilled') console.log('hash:', r.result.hash);
  else console.error('failed:', r.error.message);
});
```

### Horizon Event Handler

Process Stellar Horizon payment, ledger, and contract events with idempotency:

```typescript
import { HorizonEventHandler } from 'soroban-ts-sdk';

const handler = HorizonEventHandler.create({
  secret: process.env.HORIZON_WEBHOOK_SECRET!,
  onEvent: async (event) => {
    if (event.type === 'payment') {
      await processPayment(event);
    }
  },
});

// Express route
app.post('/horizon/events', handler.middleware());
```

### WASM Upload Pipeline

Hash, validate, and prepare a Soroban contract WASM before deploying:

```typescript
import { WasmPipeline } from 'soroban-ts-sdk';

const pipeline = new WasmPipeline({ sandboxDir: './contracts/target' });

const result = await pipeline.process('my_contract.wasm');
console.log('SHA-256:', result.sha256);
console.log('Size:   ', result.totalBytes, 'bytes');
console.log('Valid:  ', result.integrityVerified);

// Use result.sha256 with `stellar contract install --wasm-hash`
```

## Repository Structure

```
soroban-ts-sdk/
├── src/
│   ├── contractCache.ts        # Soroban contract state LRU+Redis cache
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
│   └── ci.yml                  # Build + test on every push/PR
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

### Lint

```bash
npm run lint
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Issues tagged [`good first issue`](../../issues?q=label%3A%22good+first+issue%22) are beginner-friendly starting points.

## Stellar Resources

- [Soroban Documentation](https://developers.stellar.org/docs/smart-contracts)
- [Stellar SDK for JS](https://github.com/stellar/js-stellar-sdk)
- [Soroban RPC Reference](https://developers.stellar.org/docs/data/rpc)
- [Horizon API Reference](https://developers.stellar.org/api/horizon)

## License

MIT — see [LICENSE](LICENSE).
