import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('GET /health', () => {
  it('responde ok', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('POST /events', () => {
  // La ruta real es /events, no /api/events: Kong quita el /api antes de reenviar
  // (contracts/README.md confirma el mismo patrón en auth-service: /api/auth -> /auth).
  it('rechaza sin token', async () => {
    const res = await request(createApp()).post('/events').send({});
    expect(res.status).toBe(401);
  });
});
