// Los logs de petición no deben dejar en claro el bearer token ni las cookies, ni la ubicación.
import { Writable } from 'node:stream';
import express from 'express';
import pinoHttp from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';

// Hace una petición contra una app mínima con el mismo logger y devuelve lo que quedó escrito.
async function logOf(send) {
  const lines = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const app = express();
  app.use(pinoHttp({ logger: createLogger(sink, 'info') }));
  app.get('/events', (req, res) => res.cookie('sid', 'cookie-de-respuesta-789').json({ ok: true }));
  await send(app);
  return lines.join('');
}

describe('logger', () => {
  it('redacta Authorization y las cookies en el log de cada petición', async () => {
    const log = await logOf((app) =>
      request(app)
        .get('/events')
        .set('Authorization', 'Bearer token-secreto-123')
        .set('Cookie', 'sid=cookie-secreta-456'),
    );

    expect(log).toContain('/events'); // sí se registró la petición
    expect(log).not.toContain('token-secreto-123');
    expect(log).not.toContain('cookie-secreta-456');
    expect(log).not.toContain('cookie-de-respuesta-789');
    expect(log).toContain('[REDACTED]');
  });

  it('no registra la consulta de la URL: el mapa envía la ubicación (RNF5, Ley 1581)', async () => {
    const log = await logOf((app) => request(app).get('/events?lat=4.7826&lng=-74.0423&radiusKm=5'));

    expect(log).toContain('"url":"/events"'); // sí se registró la petición, sin la consulta
    expect(log).not.toContain('4.7826');
    expect(log).not.toContain('-74.0423');
  });
});
