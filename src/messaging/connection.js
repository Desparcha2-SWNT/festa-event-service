import { connect } from 'amqplib';
import { config } from '../config.js';
import { logger } from '../logger.js';

/** Reintenta la conexión a RabbitMQ con backoff fijo; no se rinde (lo necesita el servicio para arrancar). */
export async function connectWithRetry(retryMs = 3000) {
  for (;;) {
    try {
      const connection = await connect(config.amqpUrl);
      connection.on('error', (err) => logger.error(err, 'conexión AMQP perdida'));
      return connection;
    } catch (err) {
      logger.warn({ err }, `no se pudo conectar a RabbitMQ, reintentando en ${retryMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
