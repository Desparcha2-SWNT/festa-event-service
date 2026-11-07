import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { parseTrustProxy } from '../src/config.js';

// El límite por IP de src/events/routes.js (120/min) corre antes de la autenticación, así que
// basta con peticiones sin token (401) para llenarlo. El limitador es del módulo: este archivo
// usa IPs propias para no chocar con otras pruebas.
const LIMIT = 120;

async function hit(app, ip) {
  return request(app).post('/events').set('X-Forwarded-For', ip).send({});
}

describe('trust proxy (detrás de Kong)', () => {
  it('el límite por IP cuenta a cada cliente por separado, no a Kong', async () => {
    const app = createApp({ trustProxy: 1 });

    for (let i = 0; i < LIMIT; i += 1) {
      const res = await hit(app, '203.0.113.10');
      expect(res.status).toBe(401);
    }
    expect((await hit(app, '203.0.113.10')).status).toBe(429);

    // Otro cliente que entra por el mismo proxy no hereda el límite del primero.
    expect((await hit(app, '203.0.113.20')).status).toBe(401);
  });
});

describe('parseTrustProxy', () => {
  it('por defecto confía en un proxy (Kong)', () => {
    expect(parseTrustProxy(undefined)).toBe(1);
    expect(parseTrustProxy('')).toBe(1);
  });

  it('acepta números, booleanos y listas de subredes', () => {
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('0')).toBe(0);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});
