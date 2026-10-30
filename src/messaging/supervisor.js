import { connect } from 'amqplib';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { startOutboxPublisher } from './outboxPublisher.js';
import { startInboxConsumer } from './inboxConsumer.js';

/**
 * Conecta a RabbitMQ, arranca el publicador del outbox y el consumidor del inbox, y si la
 * conexión se cae EN CUALQUIER MOMENTO (no solo al arrancar) los vuelve a armar sobre una
 * conexión nueva. Sin esto, un blip de RabbitMQ después de que el servicio ya está arriba lo
 * deja sordo y mudo para siempre — nadie se entera, porque el HTTP sigue respondiendo (Postgres
 * sigue vivo) y el `/health` solo mira el proceso, no esta conexión.
 */
export async function startMessaging({ retryMs = 3000 } = {}) {
  let stopped = false;
  let current = null;

  async function connectOnce() {
    for (;;) {
      try {
        return await connect(config.amqpUrl);
      } catch (err) {
        logger.warn({ err }, `no se pudo conectar a RabbitMQ, reintentando en ${retryMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
  }

  async function wire() {
    const connection = await connectOnce();
    const publisher = startOutboxPublisher(connection);
    const consumerChannel = await startInboxConsumer(connection);
    current = { connection, publisher, consumerChannel };

    connection.once('close', () => {
      if (stopped) return;
      logger.warn('conexión AMQP cerrada inesperadamente, reconectando');
      wire().catch((err) => logger.error(err, 'no se pudo reconectar a RabbitMQ'));
    });
    connection.on('error', (err) => logger.error(err, 'error en la conexión AMQP'));
  }

  await wire(); // bloquea hasta la primera conexión, igual que antes de este cambio

  return {
    stop: async () => {
      stopped = true;
      if (current) {
        current.publisher.stop();
        await current.consumerChannel.close().catch(() => {});
        await current.connection.close().catch(() => {});
      }
    },
  };
}
