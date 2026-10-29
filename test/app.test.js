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

describe('POST /api/events', () => {
  it('rechaza sin token', async () => {
    const res = await request(createApp()).post('/api/events').send({});
    expect(res.status).toBe(401);
  });
});
