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
