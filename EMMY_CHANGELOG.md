# EMMY_CHANGELOG.md

This file is the single source of truth for all changes made to this repository
as part of the Stellar Wave Program resubmission audit. Entries are append-only
and ordered from oldest to newest.

---

## 2026-09-19 — Scope Audit

**Finding:**
`typescript-backend-utils` is 100% Soroban-relevant. All 5 modules solve
specific Soroban/Stellar backend problems:

- `contractCache`: Soroban's `liveUntilLedgerSeq` TTL model is unique to the
  ecosystem; this cache handles it correctly (persistent vs temporary expiry,
  archived entry detection, `RestoreFootprintOperation` signalling).
- `rpcRateLimiter`: Stellar RPC and Horizon both enforce rate limits; the
  token-bucket handles per-endpoint per-IP limiting with Redis.
- `transactionBatcher`: Soroban transactions must be submitted individually;
  this handles concurrent submission with backoff for `txInsufficientFee` errors.
- `horizonEventHandler`: Horizon webhook events need HMAC verification and
  replay protection; this implements both.
- `wasmPipeline`: Soroban contract uploads require WASM validation before
  `stellar contract install`; this pipeline computes the correct on-chain hash.

The repo name `typescript-backend-utils` is misleading. The package is already
named `soroban-ts-sdk` in `package.json` and the README leads with Stellar/Soroban
context. No renaming action was taken on the repo itself (that would affect
existing URLs), but documentation foregrounds the Soroban focus.

---

## 2026-09-19 — Branch: feat/changelog

**What changed:**
- Added `CHANGELOG.md` following Keep a Changelog format
- Documents all features shipped in v0.1.0 for all 5 modules
- Creates [Unreleased] section for future changes

**Why:**
The package was missing a changelog. The changelog surfaces the depth of what
the package actually does (Soroban TTL-aware caching, atomic Lua rate limiting,
HMAC timing safety, etc.) in a format that evaluators and library consumers can
scan quickly.

**Branch:** feat/changelog → main (awaiting PR merge)

---

---

## 2026-09-19 — Branches: fix/ci-run-tests, feat/publish-workflow, feat/v0.1.0-tag

**What changed:**
- `fix/ci-run-tests`: Added `cache: "npm"` to the CI workflow's `setup-node` step for faster dependency installs on repeated runs
- `feat/publish-workflow`: Added `.github/workflows/publish.yml` — triggers on `v*.*.*` tags, installs, builds, then publishes to npm using `NPM_TOKEN` secret
- `feat/v0.1.0-tag`: Fixed broken `[0.1.0]` link in `CHANGELOG.md` (had trailing `/**` making it an invalid URL)

**Why:**
CI was missing npm caching, causing full reinstalls on every run. The publish workflow enables automated npm releases — previously there was no way to publish without manual steps. The CHANGELOG link pointed to a non-existent URL due to a trailing `/**`.

**Branches:** fix/ci-run-tests, feat/publish-workflow, feat/v0.1.0-tag → main (awaiting merge)
