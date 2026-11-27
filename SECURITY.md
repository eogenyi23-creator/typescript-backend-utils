# Security Policy

## Supported versions

Security fixes are applied to the latest version on the `main` branch.

| Version | Supported |
|---------|-----------|
| latest (main) | ✅ |

## Reporting a vulnerability

**Do not report security vulnerabilities through public GitHub issues.**

Open a [GitHub private security advisory](https://github.com/eogenyi23-creator/typescript-backend-utils/security/advisories/new) for this repository. You should receive a response within 48 hours. If the issue is confirmed, a patch will be released as soon as possible.

### What to include

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof of concept
- The affected module(s) and version(s)
- Any suggested mitigations

## Not audited

This library has not undergone a formal security audit. It is not formally verified against any security standard. See [`docs/claims-audit.md`](docs/claims-audit.md) for a table of what is and is not verified by code and tests.

## What is and is not verified

[`docs/claims-audit.md`](docs/claims-audit.md) contains a row-by-row mapping of every factual claim in the README, module headers, and this file to the implementing code and the test that exercises it. Status is `test-backed`, `code-only`, or `not verified`. The live-evidence table in that file records the real run date and result for each claim.

## Security considerations by module

### `contractCache`

- Cache keys are serialised contract IDs and storage keys. Ensure contract IDs come
  from trusted sources.
- Redis connections should use TLS (`rediss://`) when the connection traverses an
  untrusted network.
- The cache does not validate that returned values are still current on-chain. Combine
  with ledger sequence checks for security-sensitive reads.

### `rpcRateLimiter`

- The Lua token bucket script is atomic within a single Redis instance. In a Redis
  Cluster, ensure bucket keys hash to the same slot (see SECURITY note in
  [`docs/claims-audit.md`](docs/claims-audit.md) claim #46).
- The limiter fails open on Redis errors — requests pass through rather than being
  blocked. This is intentional to avoid cascading failures, but it means rate limiting
  is temporarily bypassed when Redis is unreachable.

### `horizonEventHandler`

- Uses `crypto.timingSafeEqual` for HMAC-SHA256 signature verification against the
  `x-stellar-signature` header (also accepts `x-signature-sha256`). Never compare
  signatures with `===`.
- Replay protection: payloads older than `maxAgeSeconds` (default 300 s) or more than
  60 s in the future are rejected with 400. Adjust `maxAgeSeconds` based on your clock
  skew tolerance.
- Horizon itself does not send webhooks. This handler is for use with a relay service
  that forwards Horizon event data as HMAC-signed HTTP POST requests. The relay must
  set the shared secret in the `x-stellar-signature` header.
- The in-memory idempotency store (`HorizonIdempotencyStore`) does not survive process
  restarts. Use `RedisIdempotencyStore` for durability across instances or restarts.

### `wasmPipeline`

- Path traversal prevention is enforced via `validateWasmPath`. Always pass untrusted
  file paths through this function before reading or processing them.
- The pipeline computes SHA-256 matching the Stellar network's `wasm-hash`. Verify
  this hash on-chain before trusting a deployed contract. The hash match against the
  network was verified on 2026-11-27: WASM hash
  `cf46518c3c6cc678788e52340431638a21d56c1c42822dc2643f1af0e4f10391` matched the
  hash returned by the real upload (harness check A1 — see
  [`docs/testnet-run.md`](docs/testnet-run.md)).

### `transactionBatcher`

- Transaction signing should happen before passing tasks to the batcher. Do not pass
  unencrypted private keys through task closures.
- Implement appropriate sequence number management to avoid `txBadSeq` errors under
  concurrent submission.
