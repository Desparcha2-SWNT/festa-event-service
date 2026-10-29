import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './logger.js';
import { eventsRouter } from './events/routes.js';

export function createApp() {
  const app = express();
  app.use(pinoHttp({ logger }));
  app.use(express.json());

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/events', eventsRouter);

  app.use((err, req, res, _next) => {
    req.log.error(err);
    res.status(500).json({ error: 'error interno' });
  });

  return app;
}
