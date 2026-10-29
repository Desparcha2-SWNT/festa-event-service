import { withTransaction } from '../db/pool.js';
import { logger } from '../logger.js';

const QUEUE = 'event-service.inbox';
const RETRY_QUEUE = 'event-service.inbox.retry';
const MAX_RETRIES = 3;

// Se completa a medida que event-service necesite reaccionar a eventos de otros dominios
// (hoy consume account.deleted de festa.auth, ver contracts/rabbitmq/definitions.json).
// Cada handler recibe `data` del sobre y el `client` de una transacción ya abierta.
const handlers = {
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
  const envelope = JSON.parse(msg.content.toString());
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
