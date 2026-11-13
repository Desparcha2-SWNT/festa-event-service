// SCRUM-68 y SCRUM-69: cancelar un evento y la regla de que solo su creador puede hacerlo.
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { jwtPrivateKeyPem } from '../fixtures/jwtKeys.js';

const h = vi.hoisted(() => ({ query: vi.fn(), enqueue: vi.fn() }));

vi.mock('../../src/db/pool.js', () => ({
  pool: { query: h.query },
  withTransaction: (fn) => fn({ query: h.query }),
}));
vi.mock('../../src/messaging/outboxRepository.js', () => ({ enqueue: h.enqueue }));

const { createApp } = await import('../../src/app.js');
const { toApi, toCancelledMessage } = await import('../../src/events/repository.js');

const EVENT_ID = '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a';
const OWNER_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_ID = '550e8400-e29b-41d4-a716-446655440000';

const row = {
  id: EVENT_ID,
  organizer_id: OWNER_ID,
  organizer_type: 'user',
  merchant_id: null,
  organizer_name: 'Ana',
  title: 'Noche de jazz',
  description: 'Jazz en vivo',
  description_ai_generated: false,
  category: 'musical',
  tags: [],
  starts_at: new Date('2099-01-01T01:00:00Z'),
  ends_at: new Date('2099-01-01T04:00:00Z'),
  venue_name: 'Café',
  venue_address: 'Cl. 11',
  lat: 4.6,
  lng: -74.07,
  capacity: null,
  ticketed: false,
  price_cents: 0,
  max_tickets_per_order: null,
  currency: 'COP',
  featured: false,
  is_live: false,
  cover_image_url: null,
  status: 'published',
  version: 1,
  updated_at: new Date('2026-11-10T15:00:00Z'),
};

function token(sub) {
  return jwt.sign({ role: 'user' }, jwtPrivateKeyPem, {
    algorithm: 'RS256',
    issuer: process.env.JWT_ISSUER,
    subject: sub,
    expiresIn: '15m',
  });
}

function cancel(sub, body = { reason: 'Lluvia' }, id = EVENT_ID) {
  return request(createApp()).post(`/events/${id}/cancel`).set('Authorization', `Bearer ${token(sub)}`).send(body);
}

/** La primera consulta es el SELECT ... FOR UPDATE; la segunda, el UPDATE. */
function dbReturns(current) {
  h.query.mockResolvedValueOnce({ rows: current ? [current] : [] });
  h.query.mockResolvedValueOnce({ rows: [{ ...current, status: 'cancelled', version: 2 }] });
}

beforeEach(() => {
  h.query.mockReset();
  h.enqueue.mockReset();
});

describe('POST /events/:id/cancel', () => {
  it('rechaza sin token', async () => {
    const res = await request(createApp()).post(`/events/${EVENT_ID}/cancel`).send({ reason: 'x' });
    expect(res.status).toBe(401);
  });

  it('rechaza un id que no es uuid', async () => {
    const res = await cancel(OWNER_ID, { reason: 'x' }, 'nope');
    expect(res.status).toBe(400);
  });

  it.each([[{}], [{ reason: '   ' }], [{ reason: 'a'.repeat(501) }], [{ reason: 'x', extra: 1 }]])(
    'rechaza el cuerpo %j',
    async (body) => {
      const res = await cancel(OWNER_ID, body);
      expect(res.status).toBe(400);
      expect(h.query).not.toHaveBeenCalled();
    },
  );

  it('el creador cancela: sube la versión y encola event.cancelled', async () => {
    dbReturns(row);
    const res = await cancel(OWNER_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', version: 2 });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][1]).toMatchObject({
      exchange: 'festa.event',
      routingKey: 'event.cancelled',
      payload: { eventId: EVENT_ID, organizerId: OWNER_ID, reason: 'Lluvia', version: 2 },
    });
  });

  it('otro usuario recibe 403 y no cambia nada', async () => {
    dbReturns(row);
    const res = await cancel(OTHER_ID);

    expect(res.status).toBe(403);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('un evento que no existe da 404', async () => {
    dbReturns(null);
    const res = await cancel(OWNER_ID);
    expect(res.status).toBe(404);
  });

  it.each([
    ['ya cancelado', { status: 'cancelled' }],
    ['oculto por moderación', { status: 'hidden' }],
    ['expirado', { status: 'expired' }],
    ['ya terminado', { ends_at: new Date('2020-01-01T00:00:00Z') }],
  ])('un evento %s da 409 y no publica', async (_name, patch) => {
    dbReturns({ ...row, ...patch });
    const res = await cancel(OWNER_ID);

    expect(res.status).toBe(409);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

const contractsDir = process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts');
const schemaPath = path.join(contractsDir, 'events/event/event.cancelled.schema.json');

describe.skipIf(!fs.existsSync(schemaPath))('event.cancelled cumple el contrato de festa-infra', () => {
  it('el mensaje valida contra el esquema', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));

    validate(toCancelledMessage(toApi({ ...row, status: 'cancelled', version: 2 }), 'Lluvia'));
    expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
  });
});
