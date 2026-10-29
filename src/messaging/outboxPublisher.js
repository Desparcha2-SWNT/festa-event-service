import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { logger } from '../logger.js';

/**
 * Publica lo pendiente en `outbox` con publisher confirms (ver contracts/README.md § Publicar).
 * Si falla la confirmación, la fila queda sin `sent_at` y se reintenta en el siguiente tick.
 */
export function startOutboxPublisher(connection, { intervalMs = 2000 } = {}) {
  let stopped = false;
  let channelPromise = connection.createConfirmChannel();

  const tick = async () => {
    if (stopped) return;
    try {
      const channel = await channelPromise;
      const { rows } = await pool.query(
        `SELECT id, exchange, routing_key, payload FROM outbox
         WHERE sent_at IS NULL ORDER BY created_at LIMIT 50`,
      );

      for (const row of rows) {
        const envelope = {
          eventId: randomUUID(),
          eventType: row.routing_key,
          version: 1,
          occurredAt: new Date().toISOString(),
          producer: 'event-service',
          correlationId: randomUUID(),
          causationId: null,
          data: row.payload,
        };
        const content = Buffer.from(JSON.stringify(envelope));

        await new Promise((resolve, reject) => {
          channel.publish(
            row.exchange,
            row.routing_key,
            content,
            { persistent: true, contentType: 'application/json', messageId: envelope.eventId, type: envelope.eventType },
            (err) => (err ? reject(err) : resolve()),
          );
        });

        await pool.query('UPDATE outbox SET sent_at = now() WHERE id = $1', [row.id]);
      }
    } catch (err) {
      logger.error(err, 'fallo publicando el outbox, se reintenta en el siguiente tick');
      channelPromise = connection.createConfirmChannel();
    } finally {
      if (!stopped) setTimeout(tick, intervalMs);
    }
  };

  tick();
  return { stop: () => { stopped = true; } };
}
