# Changelog

All notable changes to `soroban-ts-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### 2026-11-27 — fix/harness-corrections (Task 1: remove foreign contract IDs from committed file)

#### Changes
- **`testnet/run.mjs`** — `assertNotForeignContract` no longer contains a
  hard-coded list of foreign contract IDs.  It now reads an optional
  `FORBIDDEN_CONTRACT_IDS` environment variable (comma-separated list supplied
  by the operator at runtime; never committed).  If set and the deployed ID
  matches any entry, the same `SAFETY STOP` error is thrown.  If not set, it
  prints: `Contract-ID safety check: not configured (set FORBIDDEN_CONTRACT_IDS
  to enable)`.  The function now delegates to `checkForbiddenContractId` from
  `testnet/helpers.ts`, and imports `checkForbiddenContractId` and
  `isTerminalStatus` from `dist/testnet/helpers.js` at startup via a top-level
  dynamic import.
- **`testnet/helpers.ts`** — added two new exports:
  - `checkForbiddenContractId(contractId, env)`: pure function that parses
    `FORBIDDEN_CONTRACT_IDS` from the env map and checks for a match.  Returns a
    discriminated-union result so callers can log and act without coupling to the
    error message.
  - `isTerminalStatus(status)`: pure predicate used by `pollTransaction` (see
    Task 2).
- **`tests/harnessHelpers.test.ts`** — added 13 new tests: 6 for
  `isTerminalStatus` (SUCCESS true, FAILED true, NOT_FOUND false, PENDING false,
  undefined false, unrecognised false) and 7 for `checkForbiddenContractId`
  (variable unset, empty string, whitespace-only, no match, exact match, match
  with extra whitespace, prefix non-match).  All fake IDs in the test file are
  generated locally (56-char strings starting with `C`) with no connection to any
  real deployed contract.
- **`docs/testnet.md`** — added "Contract ID safety check" section at the top;
  updated the commands example to show `FORBIDDEN_CONTRACT_IDS`; updated the
  troubleshooting table row to reflect the new error message.

#### Why
Part 3a merged four real foreign contract IDs into `testnet/run.mjs`.  Those IDs
belong to other projects and must not appear in this repo.  The fix moves the list
out of the committed file entirely.

The old IDs remain in earlier commits in git history; they are not rewritten.

#### Verification
```
grep -rnE "\bC[A-Z2-7]{55}\b" --exclude-dir=node_modules --exclude-dir=target \
  --exclude-dir=.git .
```
Hits: `CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM` in
`examples/contract-cache.ts`, `README.md`, and six contract test-snapshot files
(well-known Soroban SDK placeholder, not a foreign deployed ID); and three fake
IDs (`CAAA…AAA`, `CBBB…BBB`, `CDDD…DDD`) in `tests/harnessHelpers.test.ts`.
None of the four foreign IDs from Part 3a appear in the working tree.

```
npm run lint                 → exit 0
npm run build                → exit 0
npm test -- --testPathIgnorePatterns="tests/integration"
  → 155 passed, 0 failed
npm run check:examples       → exit 0
npm run check:readme-examples → all 5 snippet(s) matched. ✓
npm run check:claims         → 46 rows validated. ✓
```

#### Limits
The old IDs remain in git history (earlier commits on the merged `feat/testnet-harness`
branch).  Git history is not rewritten.

---

### 2026-11-27 — fix/harness-corrections (Task 2: fix pollTransaction treating NOT_FOUND as terminal)

#### Changes
- **`testnet/helpers.ts`** — added `isTerminalStatus(status)`: returns `true`
  only for `"SUCCESS"` and `"FAILED"`.  `"NOT_FOUND"`, `"PENDING"`, `undefined`,
  and any unrecognised string all return `false`.
- **`testnet/run.mjs`** — `pollTransaction` now uses `isTerminalStatus` instead
  of an inline string comparison.  `NOT_FOUND` is no longer treated as a terminal
  state; the loop continues polling until `SUCCESS` or `FAILED` is received, or
  the deadline expires.  On timeout, the error message now includes the last
  status seen (e.g. `last status: NOT_FOUND`).  The variable `lastStatus` is
  tracked across iterations.  RPC errors still propagate immediately (no
  `catch { continue }`).
- Caller at line ~561 (check C1 hash re-confirmation) already only acts on
  `tx.status === "SUCCESS"` and treats anything else as a failure — no change
  needed; `pollTransaction` now guarantees it never returns a `NOT_FOUND` result.

#### Why
On Stellar RPC, `NOT_FOUND` immediately after submission means the node has not
yet indexed the transaction in a ledger.  Treating it as terminal caused a valid
transaction to be reported as a false timeout or false failure.  Only `SUCCESS`
and `FAILED` are permanent outcomes.

#### Verification
```
npm run lint                 → exit 0
npm run build                → exit 0
npm test -- --testPathIgnorePatterns="tests/integration"
  → 155 passed, 0 failed
npm run check:examples       → exit 0
npm run check:readme-examples → all 5 snippet(s) matched. ✓
npm run check:claims         → 46 rows validated. ✓
```
Live end-to-end harness run: not run — requires testnet access and a funded
deployer key; awaiting owner execution.

#### Limits
The polling interval is fixed at 2 s; a very long indexing delay could still
exhaust the timeout.  The timeout message now names the last status to aid
diagnosis.

### 2026-11-27 — feat/testnet-harness (Task 1: kv-test Soroban contract)

#### Changes
- **`testnet/contract/`**: New Cargo workspace (separate from the npm package).
  - `kv-test` crate: minimal Soroban contract with `set(key, value)`,
    `get(key) → Option<u64>`, and `increment(key) → u64`. Persistent storage;
    TTL extended on every write (17 280 ledgers ≈ 24 h). No auth — documented
    as a test fixture only.
  - `rust-toolchain.toml`: pins `stable` channel with `wasm32v1-none` target,
    `rustfmt`, and `clippy`.
  - `Cargo.lock` committed with `ed25519-dalek` pinned to `2.2.0`.
  - 7 unit tests via `soroban-sdk` testutils: set/get, missing key, increment
    from zero, increment across multiple calls, increment builds on set,
    overwrite with set, independent keys.
- **Dependency conflict resolved**: `soroban-env-host 22.1.3` declares
  `ed25519-dalek = ">=2.0.0"` but was written against the rand_core 0.6 API
  of version 2.x. Without intervention Cargo resolves to 3.0.0, whose
  `SigningKey::generate` takes a rand_core 0.10 `CryptoRng`, which
  `ChaCha20Rng` (rand_core 0.6) does not satisfy. Fix: `Cargo.lock` pins
  `ed25519-dalek` to `2.2.0` via `cargo update ed25519-dalek@3.0.0 --precise
  2.2.0`. Explanation written in `testnet/contract/Cargo.toml`.
- **`.gitignore`**: Added `testnet/last-run.txt` and `testnet/contract/target/`.
- **`.github/workflows/ci.yml`**: Added `contract` job (fmt, clippy, test,
  build) using `dtolnay/rust-toolchain@stable`.

#### Why
Part 3a requires a contract owned exclusively by this repo; no foreign contract
ID may be used. This minimal KV fixture is the smallest contract that exercises
all three check types (read, write, increment).

#### Verification
```
cargo fmt --all -- --check   → exit 0  (in testnet/contract/)
cargo clippy --all-targets -- -D warnings → exit 0
cargo test --locked          → 7 passed, 0 failed
stellar contract build       → kv_test.wasm 1401 bytes, wasm hash printed
npm run lint                 → exit 0
npm run build                → exit 0
npm test -- --testPathIgnorePatterns="tests/integration" → 128 passed
npm run check:examples       → exit 0
npm run check:readme-examples → all 5 snippet(s) matched. ✓
npm run check:claims         → 46 rows validated. test-backed: 45 code-only: 1 ✓
```

#### Limits
- Contract has no auth. Intentional — it is a test fixture.
- The `--precise` pin only applies while the Cargo.lock is respected; `cargo
  update` without `--locked` could re-introduce 3.0.0 on a future run.
- WASM build requires the `wasm32v1-none` target; not in a default Rust install.

---

### 2026-11-27 — feat/testnet-harness (Task 2: testnet harness script)

#### Changes
- **`testnet/run.mjs`**: Node ESM harness, runnable with `npm run testnet`.
  - Prerequisite check: Node ≥ 20, stellar CLI present, WASM built (builds if
    missing).
  - Generates fresh throwaway keypairs via `stellar keys generate --no-fund`
    and funds them through Friendbot. Keys are never written to disk or printed.
  - Deploys a fresh kv-test contract instance per run via `stellar contract
    install` + `stellar contract deploy`. Prints real WASM hash and contract ID.
  - Contract ID safety check: refuses to proceed if the deployed ID matches any
    known foreign contract (IDs checked at runtime only; not committed).
  - Check A (WasmPipeline): SHA-256 match, non-WASM rejection, sandbox path
    rejection.
  - Check B (ContractCache): single-fetch for two reads, re-read after
    `cache.delete()`, missing key returns null.
  - Check C (TransactionBatcher): 2 valid + 1 invalid task; valid succeed,
    invalid fails independently; on-chain counters verified.
  - Check D (RpcRateLimiter): requires `REDIS_URL`; fires 65 requests against
    60-token bucket; asserts 60 allowed / 5 blocked; bucket reset.
  - Check E (HorizonEventHandler): local only; valid, wrong sig, duplicate,
    old timestamp, future timestamp, missing sig.
  - Polling uses raw JSON-RPC `getTransaction` (not SDK); errors are propagated,
    never swallowed in a `catch { continue }`.
  - Summary table printed; full output written to `testnet/last-run.txt`
    (git-ignored).
  - Exits non-zero if any check fails; skipped checks are never counted as pass.
- **`testnet/helpers.ts`**: Pure helper functions (`buildSummaryTable`,
  `formatSummaryTable`, `shouldSkipCheck`) extracted for unit testing.
- **`package.json`**: Added `"testnet": "node testnet/run.mjs"` script.
  Added `"!dist/testnet"` to `files` to keep test helpers out of the published
  package.
- **`tsconfig.json`**: `rootDir` widened to `.` and `testnet/helpers.ts` added
  to `include` so the helpers compile and are importable from tests.

#### Why
The harness fulfils the requirement that anyone can run a live check with one
command. It fails loudly on every problem rather than masking errors.

#### Verification
```
node --input-type=module --check < testnet/run.mjs → exit 0
npm run lint                 → exit 0
npm run build                → exit 0
npm test -- --testPathIgnorePatterns="tests/integration" → 142 passed (14 new)
npm run check:examples       → exit 0
npm run check:readme-examples → all 5 snippet(s) matched. ✓
npm run check:claims         → 46 rows validated. ✓
```
Live run: not yet run — awaiting owner execution.

#### Limits
- `stellar contract invoke` does not expose the transaction hash in its stdout;
  the `--verbose` stderr line is searched as a best-effort fallback. Check C3
  verifies on-chain state directly.
- Check D simulates window refill by deleting the Redis key; real window expiry
  would require waiting 60 s.

---

### 2026-11-27 — feat/testnet-harness (Task 4: docs, unit tests, claims-audit update)

#### Changes
- **`docs/testnet.md`**: New document. Describes each check, prerequisites
  (stellar CLI, Rust target, Node, optional Redis), exact commands, expected
  output format, failure meanings, and what the harness does NOT cover.
- **`tests/harnessHelpers.test.ts`**: 14 unit tests for `buildSummaryTable`,
  `formatSummaryTable`, and `shouldSkipCheck` from `testnet/helpers.ts`. No
  network or file I/O.
- **`docs/claims-audit.md`**: Live evidence rows L1–L5 now reference
  `docs/testnet.md` and name the specific harness check that will produce each
  piece of evidence. Status remains `not yet run`.

#### Why
Tests give a regression safety net for the pure helper logic. The docs give the
owner everything needed to run the harness without reading the script source.

#### Verification
```
npm run lint                 → exit 0
npm run build                → exit 0
npm test -- --testPathIgnorePatterns="tests/integration" → 142 passed
npm run check:examples       → exit 0
npm run check:readme-examples → all 5 snippet(s) matched. ✓
npm run check:claims         → 46 rows validated. ✓
```

#### Limits
Harness helper unit tests cover only the pure functions. The check functions
themselves (A–E) are integration-tested only via a live run.

### 2026-11-27 — docs/honest-docs-and-claims (Task 5: SECURITY.md and CONTRIBUTING)

#### Changes
- **SECURITY.md**: Fully rewritten.
  - Vulnerability reporting now points to a GitHub private security advisory link
    instead of a vague "email the maintainer" instruction.
  - Added plain "Not audited" section.
  - Added "What is and is not verified" section pointing to `docs/claims-audit.md`.
  - `horizonEventHandler` section rewritten to match the accurate description from
    Task 3: names the two accepted signature headers, states the 300 s / 60 s rules,
    clarifies Horizon does not send webhooks.
  - `wasmPipeline` section now links to the live-evidence row for the network hash claim.
  - Removed informal phrasing; kept all substantive module notes.
- **CONTRIBUTING.md**: Was rewritten in Task 2. Verified it contains all required
  scripts: `check:examples`, `check:readme-examples`, `check:claims`, and the Redis
  integration test command (`REDIS_URL=redis://localhost:6379 npm run test:integration`).
  No "production-ready" language. Node version is "20 or 22".

#### Why
- The old reporting instruction said "email the maintainer directly" with no address —
  useless to anyone who finds the file. A GitHub advisory link is concrete.
- The `horizonEventHandler` SECURITY.md section still had the old inaccurate description
  after Task 3 updated the other files.
- The "Not audited" statement was at the bottom of the file; moving it near the top
  makes it easier to find.

#### Verification
```
npm run lint       → exit 0
npm run build      → exit 0
npm test -- --testPathIgnorePatterns="tests/integration" → 128 passed
npm run check:examples     → exit 0
npm run check:readme-examples → all 5 snippet(s) matched. ✓
npm run check:claims → 46 rows validated. test-backed: 45  code-only: 1 ✓
```

#### Limits
The GitHub advisory link targets the actual repo. Its availability was not verified
in this environment.

---

### 2026-11-27 — docs/honest-docs-and-claims (Task 4: Claims audit)

#### Changes
- Created `docs/claims-audit.md` with 46 rows in the main claim table and 6 rows in
  the live-evidence table.
  - 45 rows: `test-backed` (each names a real test file and test title)
  - 1 row: `code-only` (Redis Cluster Lua atomicity note in SECURITY.md — cannot be
    unit-tested without a Cluster setup)
  - 0 rows: `not verified`
- Added 6 `RedisIdempotencyStore` unit tests to `tests/horizonEventHandler.test.ts`
  (using a minimal mock Redis), promoting claim #35 from `code-only` to `test-backed`.
  Tests cover: `hasAndMark` returns false on first call, returns true on duplicate,
  `has()` before and after `mark()`, NX semantics (no overwrite), custom key prefix.
- Created `scripts/check-claims.mjs`: reads the claim table, validates each
  `test-backed` row's named file exists in `tests/` and the leaf test title appears
  in that file, reports counts by status. Exits non-zero on any failure.
- Added `check:claims` npm script.
- Added `check:claims` step to the `build-and-test` CI job after `check:readme-examples`.

#### Why
Surfaced the gap in `RedisIdempotencyStore` test coverage (SET NX EX behaviour). The
audit document gives a single place to track what is and isn't verified so the state
is honest to both contributors and consumers.

#### Verification
```
node scripts/check-claims.mjs →
  check-claims: 46 rows validated.
  test-backed: 45  code-only: 1  not-verified: 0 ✓

npm run lint       → exit 0
npm run build      → exit 0
npm test -- --testPathIgnorePatterns="tests/integration" → 128 passed (122 + 6 new)
npm run check:examples     → exit 0
npm run check:readme-examples → all 5 snippet(s) matched. ✓
npm run check:claims → 46 rows validated. test-backed: 45  code-only: 1 ✓
```

#### Limits
- Claim #46 (Redis Cluster Lua atomicity): `code-only`. Testing would require a real
  Redis Cluster; see SECURITY.md note.
- Live-evidence table: all 6 rows marked `not yet run`; a later part will fill these.

---

### 2026-11-27 — docs/honest-docs-and-claims (Task 3: Fix the Horizon handler description)

#### Changes
- **README** `### Horizon Event Handler` section: replaced the former description
  ("Process Stellar Horizon payment, ledger, and contract events with idempotency")
  with an accurate description of what the handler actually does: verifies HMAC-SHA256
  in `x-stellar-signature`, rejects payloads outside the replay window, deduplicates
  by event ID, and explicitly notes that Horizon does not send webhooks.
- **src/horizonEventHandler.ts** module header (started in Task 2): reflects the same
  accurate framing — relay service, `x-stellar-signature` / `x-signature-sha256` header
  names, 300 s default window, 60 s future clock-skew guard. No third-party service
  names cited as integrations.
- **SECURITY.md** `horizonEventHandler` section: rewritten to match the code — names
  the two accepted signature headers, states the 300 s / 60 s timestamp rules, clarifies
  that Horizon does not send webhooks, and notes the relay contract.

#### Why
The old description implied Horizon itself sends webhook callbacks ("Horizon streaming
events", "Horizon webhook callbacks via third-party services"). Horizon uses SSE; the
handler is for HMAC-signed HTTP callbacks from a relay that you operate. The description
was wrong in the README, module header, and SECURITY.md.

#### Verification
```
npm run lint       → exit 0
npm run build      → exit 0
npm test -- --testPathIgnorePatterns="tests/integration" → 122 passed
npm run check:examples     → exit 0
npm run check:readme-examples → all 5 snippet(s) matched. ✓
```
Signature header names verified in source: `src/horizonEventHandler.ts` line ~300:
  `req.headers["x-stellar-signature"] ?? req.headers["x-signature-sha256"]`
Default `maxAgeSeconds`: 300 s (`config.maxAgeSeconds ?? 300`)
Future-timestamp guard: 60 s (`age < -60`)

#### Limits
No code behaviour was changed. The examples use `process.env['HORIZON_WEBHOOK_SECRET']`
as the secret; the name of that env var is a placeholder, not a protocol requirement.

---

### 2026-11-27 — docs/honest-docs-and-claims (Task 2: Remove overclaims and fix naming)

#### Changes
- **README**: Added a "Names" section at the top (GitHub repo vs npm package vs import).
- **README**: Install section rewritten — `soroban-ts-sdk` is not on npm (confirmed
  404 from `npm view soroban-ts-sdk`; checked 2026-11-27). Instructions now show
  GitHub install; a commented-out `npm install soroban-ts-sdk` line is included for
  when it is eventually published.
- **README**: Added SDK version note: tested with `@stellar/stellar-sdk@13.1.0`;
  peer dependency range `>=12.0.0`; older and newer versions untested.
- **README**: Node version note: tested on Node 20.x and 22.x; Node 20+ required.
- **README**: Removed "well-tested, composable" from the description paragraph;
  replaced with "tested TypeScript modules".
- **README**: `horizonEventHandler` table description changed from "Secure, idempotent
  handler for Horizon streaming events" to "HMAC-verified handler for relay-delivered
  Horizon event callbacks" (Task 3 work starts here; full rewrite in Task 3).
- **README**: Development section expanded with integration test command.
- **CONTRIBUTING.md**: Rewritten — removed "production-ready" sentence; corrected
  all npm scripts to real names; added `check:examples`, `check:readme-examples`,
  `check:claims`; added Redis integration test command; removed incorrect claim
  about ESLint; updated Node version to "20 or 22".
- **src/horizonEventHandler.ts**: Module header rewritten — removed "streaming events"
  and "webhook callbacks via third-party services"; now accurately describes what it
  does (HMAC-signed HTTP callbacks from a relay, signature header names, timestamp
  rules, replay window). Full Task 3 rewrite in Task 3.

#### Why
- npm 404 makes the `npm install soroban-ts-sdk` instruction wrong for any reader.
- "well-tested, composable" are not measurable claims tied to anything in the code.
- "streaming events" and "webhook callbacks" misrepresent how Horizon and the handler
  actually work.
- Node and SDK version claims were vague; pinning to what CI tests is accurate.

#### Verification
```
npm view soroban-ts-sdk → npm error 404 Not Found
npm run lint       → exit 0
npm run build      → exit 0
npm test -- --testPathIgnorePatterns="tests/integration" → 122 passed
npm run check:examples     → exit 0
npm run check:readme-examples → all 5 snippet(s) matched. ✓
```

#### Limits
- Full Horizon handler description rewrite deferred to Task 3.
- SECURITY.md naming and description updates deferred to Task 5.
- npm publish status: 404 as of 2026-11-27; not verified on alternative registries.

---

### 2026-11-27 — docs/honest-docs-and-claims (Task 1: One changelog)

#### Changes
- Merged the factual history from `EMMY_CHANGELOG.md` into `CHANGELOG.md` under a
  new section `## Development history (merged from a former second changelog)`.
  Three dated entries (2026-09-19) preserved with their technical content; wording
  about an external review program and resubmission audit removed.
- Deleted `EMMY_CHANGELOG.md` with `git rm`.
- No other files reference `EMMY_CHANGELOG.md` (confirmed by `grep -rn EMMY_CHANGELOG`).
- Verified the `[0.1.0]` link at the bottom of `CHANGELOG.md` is well-formed
  (`https://github.com/eogenyi23-creator/typescript-backend-utils/releases/tag/v0.1.0`).

#### Why
Two changelogs create conflicting records. The second file contained wording tied to
an external process that is not part of the codebase's history.

#### Verification
```
git rm EMMY_CHANGELOG.md  → rm 'EMMY_CHANGELOG.md'
grep -rn EMMY_CHANGELOG . (excluding node_modules) → no results
[0.1.0] link: https://github.com/eogenyi23-creator/typescript-backend-utils/releases/tag/v0.1.0
  — well-formed URL, no trailing /** fragment
```

#### Limits
The [0.1.0] link points to a release tag; the tag's existence on GitHub is not
verified in this environment.

---

### 2026-11-27 — fix/verify-and-readme (Task 4: Test against real Redis in CI)

#### Changes
- Created `tests/integration/redis.test.ts` with 6 integration tests for
  `rpcRateLimiter` and `contractCache`, selected by the `REDIS_URL` env var and
  skipped (with a clear message) when it is not set.
  - `rpcRateLimiter` (3 tests): token bucket really limits under concurrent callers;
    two independent limiter instances share one Redis bucket; fails open when Redis
    is unreachable.
  - `contractCache` (3 tests): writes to Redis and back-fills L1 on a fresh cache
    instance; serves from L1 without hitting Redis on subsequent reads; falls back
    to L1 when Redis is down.
- Added npm script `test:integration` (`jest --testPathPattern=tests/integration`).
- Updated `.github/workflows/ci.yml`:
  - Existing `build-and-test` job now excludes `tests/integration` from `npm test`
    and `test:coverage` via `--testPathIgnorePatterns`.
  - New `integration-tests` job starts a `redis:7` service container, sets
    `REDIS_URL=redis://localhost:6379`, and runs `npm run test:integration`.
    The existing unit-test job is fully independent of Redis.

#### Why
The rate limiter and cache claim atomic Redis behaviour that cannot be exercised
with a mock (Lua script race conditions, cross-instance bucket sharing, graceful
degradation). Integration tests against a live Redis verify these guarantees.

#### Verification
```
npm run test:integration  (no REDIS_URL set) →
  Test Suites: 1 skipped
  Tests:       6 skipped, 6 total  — skips cleanly with descriptive label

npm test -- --testPathIgnorePatterns="tests/integration" →
  122 passed, 5 suites

Redis not available in this environment.
Integration tests were not executed locally; CI run against redis:7 service
container is required. See .github/workflows/ci.yml integration-tests job.
```

#### Limits
- Integration tests not executed locally (no Redis in this dev environment).
- Relies on CI redis:7 service container for real execution.
- `RedisIdempotencyStore.hasAndMark()` duplicate-detection path (lines 150-191
  of horizonEventHandler.ts) is not covered by integration tests in this task;
  it requires a Redis-backed idempotency test which would fit in a separate
  horizonEventHandler integration test file.

---

### 2026-11-27 — fix/verify-and-readme (Task 3: Close real test gaps)

#### Changes
- Added 23 new tests across four modules (99 → 122 total).
- `transactionBatcher.test.ts`: added `submitWithResults helper` and `error edge cases`
  groups (5 new tests): typed bucket split, AbortSignal forwarding, non-Error rejection
  wrapping, mid-sleep abort, pre-aborted signal before batch starts.
- `rpcRateLimiter.test.ts`: added `trustProxy and IP resolution` and `RpcRateLimiter class`
  groups (7 new tests): X-Forwarded-For string/array/comma-list parsing, socket.remoteAddress
  fallback, 'unknown' fallback, `RpcRateLimiter.create()` + `middleware()` OO interface.
- `horizonEventHandler.test.ts`: added `invalid request body`, `HorizonEventQueue`, and
  `HorizonEventHandler class` groups (5 new tests): malformed JSON 400, missing `data` field
  400, array `data` field 400, `queue.peek()`, `HorizonEventHandler.create()` + `middleware()`.
- `wasmPipeline.test.ts`: added `WasmPipeline class` group (6 new tests): `process()`,
  `validate()` on valid/invalid/too-small files, path traversal, missing file.

#### Why
Uncovered paths from baseline that matter for correctness or security:
- `trustProxy` path: bypasses IP spoofing protection if the wrong code is used
- `resolveIdentifier` socket fallback: would have silently used 'unknown' for all requests
- `RpcRateLimiter` OO interface: 0% covered despite being the documented API
- `HorizonEventHandler` OO interface: 0% covered despite being the documented API
- Invalid JSON body path: could mask content-type bugs
- `validateHorizonPayload` data-field checks: incorrect data would skip the validator
- `WasmPipeline.validate()`: the safety guard before expensive contract uploads — entirely untested
- `submitWithResults`: the main typed helper — not directly tested
- Abort mid-backoff: could leave tasks stuck in retry loops after cancellation

#### Verification
```
npm test → 122 passed, 5 suites (was 99)

Coverage before → after:
  All files:              76.5% → 87.55% stmts,  65.47% → 77.97% branch
  contractCache.ts:       86.5% → 86.5%  stmts,  83.87% → 83.87% branch  (no new tests added)
  horizonEventHandler.ts: 72.04% → 80.64% stmts, 67.39% → 76.08% branch
  rpcRateLimiter.ts:      78.78% → 100%   stmts,  41.66% → 91.66% branch
  transactionBatcher.ts:  66.66% → 86.66% stmts,  36.36% → 63.63% branch
  wasmPipeline.ts:        74.03% → 92.3%  stmts,  53.84% → 73.07% branch
```

#### Limits
- `RedisIdempotencyStore` (lines 150–191) and its `hasAndMark` duplicate-detection path
  remain untested without a live Redis; those are covered in Task 4 integration tests.
- `transactionBatcher.ts` lines 93-94 (`sleep()` pre-abort via pre-set signal) remain at
  partial coverage — the test covers the batch-level abort, not the helper function branch
  directly (the branch is covered indirectly through the existing abort tests).

---

### 2026-11-27 — fix/verify-and-readme (Task 2: Make every README example compile against the real API)

#### Changes
- Created `examples/` with one file per module (`contract-cache.ts`, `rpc-rate-limiter.ts`,
  `transaction-batcher.ts`, `horizon-event-handler.ts`, `wasm-pipeline.ts`).
- Added `tsconfig.examples.json` with a `paths` alias so examples import from
  `soroban-ts-sdk` exactly as a consumer would, resolved to `./src/index.ts` during
  type-checking.
- Added npm scripts: `check:examples` (`tsc --project tsconfig.examples.json`),
  `check:readme-examples` (`node scripts/check-readme-examples.mjs`),
  `test:coverage`, `test:integration`.
- Added `scripts/check-readme-examples.mjs`: reads `<!-- example: <name> -->` markers in
  the README and asserts each following fenced TypeScript block appears verbatim in
  `examples/<name>.ts`. Fails if no markers are found, an example file is missing,
  or the snippet is not found.
- Updated `.github/workflows/ci.yml` to run `check:examples`, `check:readme-examples`,
  and `test:coverage` after the build step.
- Rewrote the five README Quick Start snippets to match the real exported API.

#### Why (errors in the original README)
1. `SorobanRpc.Server` / `SorobanRpc.Durability` — `SorobanRpc` is not exported by
   `@stellar/stellar-sdk` v13.x. The correct namespace is `rpc`.
2. `new Address(userAddress)` — `Address` was used without being imported.
3. `cache.getOrFetch(contractId, 'balance', [new Address(...)], (key) => ...)` — wrong
   call signature. The real signature is `getOrFetch(key: ContractStateKey, fetch: () =>
   Promise<SorobanEntryResult<T>>)`: two arguments, not four.
4. `RpcRateLimiter.create('soroban-rpc', redis, { maxTokens, refillRate, windowSeconds })` —
   the third argument is a tier string (`'public'` | `'authenticated'`), not a config
   object. Config overrides go in the fourth argument.
5. `batcher.submit(txEnvelopes, fn)` — `submit` does not exist. The method is
   `submitWithResults(tasks)` where `tasks` is an array of `() => Promise<T>` functions,
   not raw transaction envelopes.

#### Verification
```
npm run check:examples      → exit 0 (5 files type-checked with tsc --noEmit)
npm run check:readme-examples → all 5 snippet(s) matched. ✓
npm run lint                → exit 0
npm run build               → exit 0
npm test                    → 99 tests, 5 suites, all passing
```

#### Limits
Examples are type-checked only (`--noEmit`). They do not run against a real Stellar
network or Redis instance. `wasm-pipeline.ts` is not executed (no `.wasm` file present).

---

### 2026-11-27 — fix/verify-and-readme (Task 1: Baseline audit)

#### Changes
- No code changes. Recorded exact baseline state before any modifications.

#### Why
Step 0 audit to confirm whether anything fails before touching the repo.

#### Verification
```
Node v24.22.2, npm 11.19.1

npm run lint   → exit 0  (tsc --noEmit, no errors)
npm run build  → exit 0
npm test -- --coverage → 5 suites, 99 tests, 0 failures

Coverage:
  contractCache.ts       86.5% stmts  83.87% branch
  horizonEventHandler.ts 72.04% stmts 67.39% branch
  rpcRateLimiter.ts      78.78% stmts 41.66% branch
  transactionBatcher.ts  66.66% stmts 36.36% branch
  wasmPipeline.ts        74.03% stmts 53.84% branch
  All files              76.5%  stmts 65.47% branch
```

#### Limits
No failures at baseline. All 99 tests pass on Node v24.22.2.

---

### Changed
- Renamed package from `typescript-backend-utils` to `soroban-ts-sdk` to clearly
  reflect the package's Soroban/Stellar focus

---

## [0.1.0] — 2026-01-15

### Added

#### `contractCache` — Ledger-sequence-aware contract state cache
- Two-tier LRU + Redis cache keyed by `contractId` + `storageKey`
- Expiry driven by Soroban's on-chain `liveUntilLedgerSeq` rather than
  wall-clock guesses
- Distinguishes persistent (archived) vs temporary (deleted) entries on expiry
- Returns `ArchivedEntryResult` for persistent entries so callers know to
  submit `RestoreFootprintOperation` before retrying
- `LedgerSequenceTracker`: polls `getLatestLedger` at most once per 4 s,
  coalesces concurrent callers onto one request
- Cache stampede prevention via per-key in-flight deduplication
- Graceful Redis degradation: L1 serves reads when Redis is unavailable

#### `rpcRateLimiter` — Token-bucket rate limiter for Stellar RPC / Horizon
- Atomic token bucket via Redis Lua script (no race conditions)
- Two built-in tiers: `public` (60 req/min), `authenticated` (300 req/min)
- Custom tier config support
- Fails open on Redis outage — requests pass through rather than hard-failing
- Sets `X-RateLimit-*` headers on every response
- `trustProxy` option for `X-Forwarded-For` support behind reverse proxies
- Framework-agnostic middleware interface (Express / Hono / Fastify)

#### `transactionBatcher` — Concurrent Soroban transaction submission
- Configurable `maxConcurrency` and `batchSize`
- Exponential backoff with full jitter (thundering-herd prevention)
- `AbortSignal` support for cancellation
- `submitWithResults()` helper returning typed `{ fulfilled, rejected }` split
- Per-task attempt tracking; completed records flushed to free memory

#### `horizonEventHandler` — Secure Horizon streaming event handler
- Constant-time HMAC-SHA256 signature verification (timing-safe)
- Replay attack prevention via configurable timestamp window (default 300 s)
- In-memory idempotency store (`HorizonIdempotencyStore`) for single-instance use
- Redis-backed idempotency store (`RedisIdempotencyStore`) using atomic `SET NX EX`
- Immediate 202 Accepted + async event queue offload
- Typed Stellar event payload (`payment`, `account_credited`, `contract_event`, etc.)

#### `wasmPipeline` — WASM validation and hash pipeline
- Streaming SHA-256 (matching `stellar contract install` wasm-hash output)
- WebAssembly magic-byte validation (`\0asm` = `0x00 0x61 0x73 0x6d`)
- Directory traversal prevention via sandbox path isolation
- Manifest JSON output: hash, size, chunk info, `completedAt`
- `WasmPipeline.validate()` throws before processing invalid files — prevents
  wasting ledger fees on a guaranteed-to-fail contract upload

### Tests
- Full Jest test suite for all 5 modules
- Mock Redis, mock Soroban RPC responses, tmp-directory WASM fixtures
- LRU eviction, ledger expiry mid-session, stampede prevention,
  Redis degradation, HMAC timing safety, path traversal, abort signal handling

---

## Development history (merged from a former second changelog)

The entries below were originally recorded in a separate file. They are reproduced
here with their original dates; wording about external review programs has been
removed, and only the factual technical content is kept.

---

### 2026-09-19 — Scope audit

**Finding:** All five modules address Stellar/Soroban-specific problems:

- `contractCache`: handles Soroban's `liveUntilLedgerSeq` TTL model, persistent vs
  temporary expiry, and `RestoreFootprintOperation` signalling.
- `rpcRateLimiter`: per-endpoint, per-IP token-bucket limiting with Redis for Stellar
  RPC and Horizon rate limits.
- `transactionBatcher`: individual Soroban transaction submission with backoff for
  `txInsufficientFee` errors.
- `horizonEventHandler`: HMAC verification and replay protection for HMAC-signed HTTP
  callbacks that deliver Horizon event data.
- `wasmPipeline`: SHA-256 hash and magic-byte validation before `stellar contract install`.

The repo name `typescript-backend-utils` is kept as-is to avoid breaking existing URLs;
the npm package is named `soroban-ts-sdk` and documentation foregrounds the Soroban focus.

---

### 2026-09-19 — Branch: feat/changelog

**What changed:** Added `CHANGELOG.md` following Keep a Changelog format; documents
all features shipped in v0.1.0 for all five modules; creates `[Unreleased]` section.

**Why:** The package was missing a changelog.

---

### 2026-09-19 — Branches: fix/ci-run-tests, feat/publish-workflow, feat/v0.1.0-tag

**What changed:**
- `fix/ci-run-tests`: added `cache: "npm"` to the CI `setup-node` step.
- `feat/publish-workflow`: added `.github/workflows/publish.yml` — triggers on `v*.*.*`
  tags, installs, builds, then publishes to npm using `NPM_TOKEN` secret.
- `feat/v0.1.0-tag`: fixed broken `[0.1.0]` link in `CHANGELOG.md` (had a trailing
  `/**` making it an invalid URL).

**Why:** CI was missing npm caching. The publish workflow enables automated releases.
The CHANGELOG link was malformed.

---

[Unreleased]: https://github.com/eogenyi23-creator/typescript-backend-utils/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/eogenyi23-creator/typescript-backend-utils/releases/tag/v0.1.0
