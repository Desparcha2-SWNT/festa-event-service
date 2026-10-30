import { withTransaction } from '../db/pool.js';
import { logger } from '../logger.js';

const QUEUE = 'event-service.inbox';
const RETRY_QUEUE = 'event-service.inbox.retry';
const MAX_RETRIES = 3;

// Se completa a medida que event-service necesite reaccionar a eventos de otros dominios
// (hoy también está en rabbitmq/definitions.json account.deleted de festa.auth, pendiente).
// Cada handler recibe `data` del sobre y el `client` de una transacción ya abierta.
const handlers = {
  'merchant.verified': async (data, client) => {
    await client.query(
      `INSERT INTO verified_merchants (merchant_id, business_name, verified_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (merchant_id) DO UPDATE SET business_name = EXCLUDED.business_name, verified_at = EXCLUDED.verified_at`,
      [data.merchantId, data.businessName, data.verifiedAt],
    );
  },
  // 'account.deleted': async (data, client) => { ... },
};

/**
 * Consume `event-service.inbox` siguiendo contracts/README.md § Consumir:
 * idempotente (tabla processed_events), reintentos vía inbox.retry y DLQ al agotarlos.
 */
export async function startInboxConsumer(connection) {
  const channel = await connection.createChannel();
  await channel.prefetch(10);

  await channel.consume(QUEUE, (msg) => {
    if (!msg) return;
    handle(channel, msg).catch((err) => logger.error(err, 'error inesperado manejando un mensaje del inbox'));
  });

  return channel;
}

async function handle(channel, msg) {
  let envelope;
  try {
    envelope = JSON.parse(msg.content.toString());
    if (!envelope?.eventId || !envelope?.eventType) throw new Error('falta eventId o eventType');
  } catch (err) {
    // Dato malformado = error permanente (contracts/README.md § Consumir): directo a la DLQ,
    // sin reintentos. Si esto no se separa del resto, el mensaje queda sin ack/nack y, con
    // prefetch 10, el consumidor se atasca después de 10 mensajes corruptos.
    logger.error({ err }, 'mensaje del inbox inválido (no es el sobre esperado), va directo a la DLQ');
    return channel.nack(msg, false, false);
  }

  const handler = handlers[envelope.eventType];

  if (!handler) {
    logger.info({ eventType: envelope.eventType }, 'sin handler para este tipo de evento todavía, se confirma sin efecto');
    return channel.ack(msg);
  }

  try {
    await withTransaction(async (client) => {
      const already = await client.query('SELECT 1 FROM processed_events WHERE event_id = $1', [envelope.eventId]);
      if (already.rowCount > 0) return; // duplicado: no se repite el efecto

      await handler(envelope.data, client);
      await client.query(
        'INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2)',
        [envelope.eventId, envelope.eventType],
      );
    });
    channel.ack(msg);
  } catch (err) {
    await handleFailure(channel, msg, envelope, err);
  }
}

async function handleFailure(channel, msg, envelope, err) {
  const retryCount = Number(msg.properties.headers?.['x-retry-count'] ?? 0);

  if (retryCount >= MAX_RETRIES) {
    logger.error({ err, eventType: envelope.eventType, retryCount }, 'reintentos agotados, va a la DLQ');
    return channel.nack(msg, false, false);
  }

  logger.warn({ err, eventType: envelope.eventType, retryCount }, 'falla transitoria, se reintenta');
  channel.sendToQueue(RETRY_QUEUE, msg.content, {
    ...msg.properties,
    headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 },
  });
  channel.ack(msg);
}

// Export solo para pruebas.
export const _internal = { handlers };
