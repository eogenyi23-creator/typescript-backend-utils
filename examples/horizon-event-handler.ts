import { HorizonEventHandler } from 'soroban-ts-sdk';

const handler = HorizonEventHandler.create({
  secret: process.env['HORIZON_WEBHOOK_SECRET'] ?? 'dev-secret',
  onEvent: async (event) => {
    if (event.type === 'payment') {
      console.log('processing payment:', event.id);
    }
  },
});

// app.post('/horizon/events', handler.middleware());
void handler;
