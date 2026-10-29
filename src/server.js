import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { connectWithRetry } from './messaging/connection.js';
import { startOutboxPublisher } from './messaging/outboxPublisher.js';
import { startInboxConsumer } from './messaging/inboxConsumer.js';

async function main() {
  await migrate();

  const connection = await connectWithRetry();
  const publisher = startOutboxPublisher(connection);
  const consumerChannel = await startInboxConsumer(connection);

  const server = createApp().listen(config.port, () => {
    logger.info({ port: config.port }, 'festa-event-service arriba');
  });

  const shutdown = async () => {
    logger.info('apagando...');
    publisher.stop();
    server.close();
    await consumerChannel.close();
    await connection.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error(err, 'no se pudo arrancar el servicio');
  process.exit(1);
});
