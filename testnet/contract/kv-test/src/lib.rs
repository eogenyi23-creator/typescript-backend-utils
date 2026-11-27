//! # kv-test contract
//!
//! A minimal Soroban key-value contract used exclusively as a test fixture for
//! the `soroban-ts-sdk` testnet harness.  It is NOT an audited production
//! contract; authentication is intentionally omitted so the harness can read
//! and write without managing keys.
//!
//! ## Persistent storage and TTL
//!
//! All entries use `Persistent` durability.  Every write extends the TTL to
//! `MAX_TTL` ledgers so entries stay live for the duration of a harness run.
//!
//! ## Entry point summary
//!
//! | Function    | Arguments          | Returns        |
//! |-------------|--------------------|----------------|
//! | `set`       | key: Symbol, v: u64 | ()            |
//! | `get`       | key: Symbol        | Option\<u64\>  |
//! | `increment` | key: Symbol        | u64            |

#![no_std]

use soroban_sdk::{contract, contractimpl, Env, Symbol};

/// Bump any entry to this ledger-sequence offset on every write so it stays
/// live through a full harness run (~30 min on testnet ≈ 360 ledgers at 5 s/ledger).
const LEDGER_TTL_BUMP: u32 = 17_280; // ~24 h at ~5 s/ledger
const LEDGER_TTL_THRESHOLD: u32 = 17_280;

#[contract]
pub struct KvTest;

#[contractimpl]
impl KvTest {
    /// Stores `value` under `key` in persistent storage and extends the TTL.
    pub fn set(env: Env, key: Symbol, value: u64) {
        env.storage().persistent().set(&key, &value);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_TTL_THRESHOLD, LEDGER_TTL_BUMP);
    }

    /// Returns the value stored under `key`, or `None` if the key is absent.
    pub fn get(env: Env, key: Symbol) -> Option<u64> {
        env.storage().persistent().get(&key)
    }

    /// Increments the value stored under `key` by one (starting from 0 if
    /// absent) and returns the new value.  Extends the TTL on every write.
    pub fn increment(env: Env, key: Symbol) -> u64 {
        let new_val: u64 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(0_u64)
            .saturating_add(1);
        env.storage().persistent().set(&key, &new_val);
        env.storage()
            .persistent()
            .extend_ttl(&key, LEDGER_TTL_THRESHOLD, LEDGER_TTL_BUMP);
        new_val
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Ledger, Env};

    fn fresh_env() -> Env {
        let env = Env::default();
        // Start the ledger at sequence 100 so TTL comparisons are meaningful.
        env.ledger().with_mut(|li| {
            li.sequence_number = 100;
            li.timestamp = 0;
        });
        env
    }

    #[test]
    fn test_set_and_get() {
        let env = fresh_env();
        let contract_id = env.register(KvTest, ());
        let client = KvTestClient::new(&env, &contract_id);
        let key = Symbol::new(&env, "mykey");

        client.set(&key, &42_u64);
        let result = client.get(&key);
        assert_eq!(result, Some(42));
    }

    #[test]
    fn test_get_missing_key() {
        let env = fresh_env();
        let contract_id = env.register(KvTest, ());
        let client = KvTestClient::new(&env, &contract_id);
        let key = Symbol::new(&env, "absent");

        let result = client.get(&key);
        assert_eq!(result, None);
    }

    #[test]
    fn test_increment_starts_at_one() {
        let env = fresh_env();
        let contract_id = env.register(KvTest, ());
        let client = KvTestClient::new(&env, &contract_id);
        let key = Symbol::new(&env, "ctr");

        let v = client.increment(&key);
        assert_eq!(v, 1, "first increment of a missing key should return 1");
    }

    #[test]
    fn test_increment_multiple_times() {
        let env = fresh_env();
        let contract_id = env.register(KvTest, ());
        let client = KvTestClient::new(&env, &contract_id);
        let key = Symbol::new(&env, "ctr");

        let v1 = client.increment(&key);
        let v2 = client.increment(&key);
        let v3 = client.increment(&key);
        assert_eq!(v1, 1);
        assert_eq!(v2, 2);
        assert_eq!(v3, 3);
    }

    #[test]
    fn test_increment_respects_existing_set() {
        let env = fresh_env();
        let contract_id = env.register(KvTest, ());
        let client = KvTestClient::new(&env, &contract_id);
        let key = Symbol::new(&env, "ctr");

        client.set(&key, &10_u64);
        let v = client.increment(&key);
        assert_eq!(v, 11, "increment should build on the value written by set");
    }

    #[test]
    fn test_overwrite_with_set() {
        let env = fresh_env();
        let contract_id = env.register(KvTest, ());
        let client = KvTestClient::new(&env, &contract_id);
        let key = Symbol::new(&env, "k");

        client.set(&key, &1_u64);
        client.set(&key, &99_u64);
        assert_eq!(client.get(&key), Some(99));
    }

    #[test]
    fn test_independent_keys() {
        let env = fresh_env();
        let contract_id = env.register(KvTest, ());
        let client = KvTestClient::new(&env, &contract_id);
        let ka = Symbol::new(&env, "a");
        let kb = Symbol::new(&env, "b");

        client.set(&ka, &1_u64);
        client.set(&kb, &2_u64);
        assert_eq!(client.get(&ka), Some(1));
        assert_eq!(client.get(&kb), Some(2));
    }
}
