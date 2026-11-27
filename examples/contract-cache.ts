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
