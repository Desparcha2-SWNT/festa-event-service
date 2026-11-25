import pino from 'pino';
import { config } from './config.js';

// Lo que no debe quedar en el log de una petición: el token, las cookies y la consulta de la URL, porque el
// mapa envía ahí la ubicación (lat y lng; RNF5, Ley 1581). pino-http la copia en `url` y en `query`.
export const redact = {
  paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]', 'req.url', 'req.query'],
  censor: (value, path) => (path.at(-1) === 'url' ? String(value).split('?')[0] : '[REDACTED]'),
};

export function createLogger(destination, level = config.logLevel) {
  return pino({ level, redact }, destination);
}

export const logger = createLogger();
