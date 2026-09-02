/**
 * soroban-ts-sdk
 *
 * TypeScript utility SDK for Stellar and Soroban developers.
 *
 * @module soroban-ts-sdk
 */

// Contract state cache (ledger-sequence-aware LRU + Redis)
export {
  ContractCache,
  LRUCache,
  LedgerSequenceTracker,
  encodeContractKey,
  type ContractCacheConfig,
  type ContractStateKey,
  type ContractDataDurability,
  type SorobanEntryResult,
  type ArchivedEntryResult,
  type CacheResult,
} from "./contractCache.js";

// Stellar RPC / Horizon rate limiter
export {
  RpcRateLimiter,
  createRpcRateLimiter,
  type RpcRateLimiterConfig,
  type RpcRateLimiterOptions,
  type RateLimitResult,
  type RpcRequest,
  type RpcResponse,
  type NextFunction,
} from "./rpcRateLimiter.js";

// Soroban transaction batcher
export {
  TransactionBatcher,
  type TransactionBatcherConfig,
  type TransactionRecord,
  type TransactionStatus,
  type TransactionTask,
  type BatcherStatus,
  type SubmitResults,
} from "./transactionBatcher.js";

// Horizon event handler
export {
  HorizonEventHandler,
  HorizonIdempotencyStore,
  RedisIdempotencyStore,
  HorizonEventQueue,
  createHorizonEventHandler,
  computeHorizonSignature,
  verifyHorizonSignature,
  validateHorizonPayload,
  type IdempotencyStore,
  type HorizonEventPayload,
  type HorizonEventHandlerConfig,
  type HorizonEventRequest,
  type HorizonEventResponse,
  type HorizonEventResult,
  type StellarEventType,
} from "./horizonEventHandler.js";

// Soroban WASM upload pipeline
export {
  WasmPipeline,
  processWasm,
  validateWasmPath,
  verifyWasmChunkIntegrity,
  type WasmPipelineConfig,
  type WasmManifest,
  type WasmChunkRecord,
} from "./wasmPipeline.js";
