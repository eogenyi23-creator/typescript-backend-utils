import { RpcRateLimiter } from 'soroban-ts-sdk';
import { Redis } from 'ioredis';

const redis = new Redis();
const limiter = RpcRateLimiter.create('soroban-rpc', redis, 'public', {
  maxTokens: 100,
  refillRate: 100 / 60,
  windowSeconds: 60,
});

// app.use('/rpc', limiter.middleware());
void limiter;
