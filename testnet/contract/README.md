# kv-test contract

A minimal Soroban key-value contract used exclusively as a test fixture for the
`soroban-ts-sdk` testnet harness.

**This is not an audited production contract.** It is a test fixture:
authentication is intentionally omitted so the harness can read and write
entries without managing authorisation keys.

## Functions

| Function    | Arguments              | Returns        | Description                                        |
|-------------|------------------------|----------------|----------------------------------------------------|
| `set`       | `key: Symbol, v: u64`  | `()`           | Stores `v` under `key`; extends TTL.               |
| `get`       | `key: Symbol`          | `Option<u64>`  | Returns the stored value, or `None` if absent.     |
| `increment` | `key: Symbol`          | `u64`          | Increments the counter at `key` (default 0 → 1).  |

All entries use `Persistent` durability. Every write extends the entry TTL by
17 280 ledgers (~24 h at 5 s/ledger) so entries stay live for the duration of a
harness run.

## Build

```sh
# From testnet/contract/
cargo test
stellar contract build  # requires wasm32v1-none target
```

The built WASM lands at `target/wasm32v1-none/release/kv_test.wasm`.

## Toolchain

Pinned in `rust-toolchain.toml`:

- channel: `stable`
- targets: `wasm32v1-none`
- components: `rustfmt`, `clippy`
