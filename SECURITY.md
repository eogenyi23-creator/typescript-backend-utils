# Security Policy

## Supported Versions

This project is in active development. Security fixes are applied to the latest version on the `main` branch.

| Version | Supported |
|---------|-----------|
| latest (main) | ✅ |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in soroban-ts-sdk, please report it by emailing the maintainer directly. You should receive a response within 48 hours. If the issue is confirmed, a patch will be released as soon as possible.

### What to include in your report

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- The affected module(s) and version(s)
- Any suggested mitigations

## Security Considerations by Module

### `contractCache`
- Cache keys are serialised contract IDs and storage keys — ensure your contract IDs come from trusted sources.
- Redis connections should use TLS (`rediss://`) in production.
- The cache does not validate that returned values are still current on-chain — always combine with ledger sequence checks for security-sensitive reads.

### `rpcRateLimiter`
- The Lua token bucket script is atomic within a single Redis instance. In a Redis Cluster, ensure bucket keys hash to the same slot.
- The limiter fails open on Redis errors — this is intentional to avoid cascading failures but means rate limiting is temporarily bypassed.

### `horizonEventHandler`
- Uses `crypto.timingSafeEqual` for HMAC signature verification — never compare signatures with `===`.
- Replay protection window defaults to 300 seconds. Adjust `maxAgeSeconds` based on your clock skew tolerance.
- The in-memory idempotency store is not persistent — use Redis-backed storage in production for durability.

### `wasmPipeline`
- Path traversal prevention is enforced via `validateWasmPath`. Always pass untrusted file paths through this function.
- The pipeline computes SHA-256 which matches the Stellar network's `wasm-hash`. Verify this hash on-chain before trusting a deployed contract.

### `transactionBatcher`
- Transaction signing should happen before passing tasks to the batcher — never pass unencrypted private keys through task closures.
- Implement appropriate sequence number management to avoid `txBadSeq` errors under concurrent submission.

## Audit Status

This library has not yet undergone a formal security audit. Use in production at your own risk, especially for high-value transaction flows.
