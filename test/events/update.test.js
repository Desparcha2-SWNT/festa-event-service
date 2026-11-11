// SCRUM-67: editar un evento (solo su creador) y listar «Mis eventos».
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
const { toApi, toRescheduledMessage } = await import('../../src/events/repository.js');

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
  capacity: 30,
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

function edit(sub, body, id = EVENT_ID) {
  return request(createApp()).patch(`/events/${id}`).set('Authorization', `Bearer ${token(sub)}`).send(body);
}

/** La primera consulta es el SELECT ... FOR UPDATE; la segunda, el UPDATE (devuelve `saved`). */
function dbReturns(current, saved = {}) {
  h.query.mockResolvedValueOnce({ rows: current ? [current] : [] });
  h.query.mockResolvedValueOnce({ rows: [{ ...current, ...saved, version: 2 }] });
}

const routingKeys = () => h.enqueue.mock.calls.map(([, message]) => message.routingKey);

beforeEach(() => {
  h.query.mockReset();
  h.enqueue.mockReset();
});

describe('PATCH /events/:id', () => {
  it('rechaza sin token', async () => {
    const res = await request(createApp()).patch(`/events/${EVENT_ID}`).send({ title: 'Otro título' });
    expect(res.status).toBe(401);
  });

  it('rechaza un id que no es uuid', async () => {
    const res = await edit(OWNER_ID, { title: 'Otro título' }, 'nope');
    expect(res.status).toBe(400);
  });

  it.each([
    ['vacío', {}],
    ['título muy corto', { title: 'ab' }],
    ['cupo en cero', { capacity: 0 }],
    ['fecha inválida', { startsAt: 'mañana' }],
    ['tipo de organizador (no editable)', { organizerType: 'merchant' }],
    ['precio (no editable)', { priceCents: 1000 }],
  ])('rechaza el cuerpo: %s', async (_name, body) => {
    const res = await edit(OWNER_ID, body);
    expect(res.status).toBe(400);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('el creador cambia el título: guarda, sube la versión y publica solo event.updated', async () => {
    dbReturns(row, { title: 'Jazz bajo las estrellas' });
    const res = await edit(OWNER_ID, { title: 'Jazz bajo las estrellas' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Jazz bajo las estrellas', version: 2 });
    expect(h.query.mock.calls[1][1]).toContain('Jazz bajo las estrellas');
    expect(routingKeys()).toEqual(['event.updated']);
    expect(h.enqueue.mock.calls[0][1].payload).toMatchObject({ eventId: EVENT_ID, version: 2 });
  });

  it('cambiar la hora de inicio también publica event.rescheduled con la hora anterior', async () => {
    const startsAt = '2099-01-01T02:00:00.000Z';
    dbReturns(row, { starts_at: new Date(startsAt) });
    const res = await edit(OWNER_ID, { startsAt });

    expect(res.status).toBe(200);
    expect(routingKeys()).toEqual(['event.updated', 'event.rescheduled']);
    expect(h.enqueue.mock.calls[1][1].payload).toMatchObject({
      previousStartsAt: '2099-01-01T01:00:00.000Z',
      startsAt,
    });
  });

  it('cambiar el lugar también publica event.rescheduled', async () => {
    const venue = { name: 'Teatro', address: 'Cra. 7', location: { lat: 4.61, lng: -74.08 } };
    dbReturns(row, { venue_name: 'Teatro', venue_address: 'Cra. 7', lat: 4.61, lng: -74.08 });
    const res = await edit(OWNER_ID, { venue });

    expect(res.status).toBe(200);
    expect(routingKeys()).toEqual(['event.updated', 'event.rescheduled']);
    expect(h.enqueue.mock.calls[1][1].payload.previousVenue).toMatchObject({ name: 'Café' });
  });

  it('la misma hora escrita de otra forma no cuenta como reprogramación', async () => {
    dbReturns(row);
    await edit(OWNER_ID, { startsAt: '2099-01-01T01:00:00Z', capacity: 40 });

    expect(routingKeys()).toEqual(['event.updated']);
  });

  it('rechaza que el evento termine antes de empezar, combinando con lo guardado', async () => {
    h.query.mockResolvedValueOnce({ rows: [row] });
    const res = await edit(OWNER_ID, { endsAt: '2099-01-01T00:30:00Z' });

    expect(res.status).toBe(400);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('otro usuario recibe 403 y no cambia nada', async () => {
    dbReturns(row);
    const res = await edit(OTHER_ID, { title: 'Hackeado' });

    expect(res.status).toBe(403);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('un evento que no existe da 404', async () => {
    dbReturns(null);
    const res = await edit(OWNER_ID, { title: 'Otro título' });
    expect(res.status).toBe(404);
  });

  it.each([
    ['cancelado', { status: 'cancelled' }],
    ['oculto por moderación', { status: 'hidden' }],
    ['ya terminado', { ends_at: new Date('2020-01-01T00:00:00Z') }],
  ])('un evento %s da 409 y no publica', async (_name, patch) => {
    dbReturns({ ...row, ...patch });
    const res = await edit(OWNER_ID, { title: 'Otro título' });

    expect(res.status).toBe(409);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe('GET /events/mine', () => {
  it('rechaza sin token', async () => {
    const res = await request(createApp()).get('/events/mine');
    expect(res.status).toBe(401);
  });

  it('devuelve los eventos del usuario autenticado', async () => {
    h.query.mockResolvedValueOnce({ rows: [row, { ...row, status: 'cancelled' }] });
    const res = await request(createApp()).get('/events/mine').set('Authorization', `Bearer ${token(OWNER_ID)}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((e) => e.status)).toEqual(['published', 'cancelled']);
    expect(h.query.mock.calls[0][1]).toEqual([OWNER_ID]);
  });
});

const contractsDir = process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts');
const schemaFor = (name) => path.join(contractsDir, `events/event/${name}.schema.json`);

describe.skipIf(!fs.existsSync(schemaFor('event.updated')))('los mensajes cumplen los contratos de festa-infra', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator = (name) => ajv.compile(JSON.parse(fs.readFileSync(schemaFor(name), 'utf8')));

  const before = toApi(row);
  const after = toApi({ ...row, starts_at: new Date('2099-01-01T02:00:00Z'), version: 2 });

  it('event.updated', () => {
    const validate = validator('event.updated');
    validate(JSON.parse(JSON.stringify(after)));
    expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
  });

  it('event.rescheduled', () => {
    const validate = validator('event.rescheduled');
    validate(toRescheduledMessage(before, after));
    expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
  });
});
