import express from 'express';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { eventsRouter } from './events/routes.js';
import { countRequests, registry } from './metrics.js';

export function createApp({ trustProxy = config.trustProxy } = {}) {
  const app = express();
  // Detrás de Kong: sin esto, req.ip es la IP de Kong y todos los clientes comparten el límite
  // por IP de routes.js (express-rate-limit además lo avisa con ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
  app.set('trust proxy', trustProxy);
  app.use(pinoHttp({ logger }));
  app.use(express.json());
  app.use(countRequests);

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  // Prometheus (festa-infra/prometheus/prometheus.yml) lo lee por la red interna; no pasa por Kong.
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });
  // El cliente le pega a /api/events; el plugin global pre-function de Kong quita el "/api"
  // antes de reenviar (ver kong.yml.tmpl, cabecera del archivo). El servicio recibe /events,
  // igual que auth-service recibe /auth aunque el cliente llame a /api/auth.
  app.use('/events', eventsRouter);

  app.use((err, req, res, _next) => {
    req.log.error(err);
    res.status(500).json({ error: 'error interno' });
  });

  return app;
}
