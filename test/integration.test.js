// event-service contra PostgreSQL + PostGIS real: mapa/búsqueda, clústeres, Parches en Vivo, conteo y
// sold out, moderación y expiración. Se salta sin TEST_DATABASE_URL (base vacía con PostGIS).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { jwtPrivateKeyPem } from './fixtures/jwtKeys.js';

const DB = process.env.TEST_DATABASE_URL;
const contractsDir = process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts');
const hasContracts = fs.existsSync(path.join(contractsDir, 'events'));

const ORGANIZER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ECI = { lat: 4.7826, lng: -74.0426 };
const CANDELARIA = { lat: 4.5981, lng: -74.0758 };
const token = jwt.sign({ role: 'user' }, jwtPrivateKeyPem, { algorithm: 'RS256', issuer: process.env.JWT_ISSUER, subject: ORGANIZER, expiresIn: '10m' });

const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();

describe.skipIf(!DB || !hasContracts)('event-service con PostGIS', () => {
  let pool;
  let createApp;
  let lifecycle;
  let withTransaction;
  let handlers;
  const api = () => request(createApp());
  const auth = (r) => r.set('Authorization', `Bearer ${token}`);
  const outbox = async (key) => (await pool.query('SELECT payload FROM outbox WHERE routing_key = $1 ORDER BY created_at', [key])).rows.map((r) => r.payload);
  const run = (type, data) => withTransaction((client) => handlers[type](data, client, { eventId: crypto.randomUUID(), eventType: type }));
  const expectValid = (name, payload) => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(contractsDir, `events/event/${name}.schema.json`), 'utf8')));
    validate(payload);
    expect(validate.errors, JSON.stringify(validate.errors)).toBeNull();
  };

  const create = (overrides = {}) =>
    auth(api().post('/events')).send({
      organizerType: 'user',
      organizerName: 'Ana',
      title: 'Partido de microfútbol',
      description: 'Ven a jugar',
      category: 'deportivo',
      startsAt: inHours(24),
      endsAt: inHours(26),
      venue: { name: 'Coliseo ECI', address: 'Autopista Norte km 13', location: ECI },
      capacity: 2,
      ...overrides,
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    ({ pool, withTransaction } = await import('../src/db/pool.js'));
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS postgis;');
    await (await import('../src/db/migrate.js')).migrate();
    ({ createApp } = await import('../src/app.js'));
    lifecycle = await import('../src/events/lifecycle.js');
    ({ _internal: { handlers } } = await import('../src/messaging/inboxConsumer.js'));
  });
  afterAll(async () => pool?.end());

  let futbolId;
  let jazzId;

  it('RF4/RF19: crea un evento normal y un Parche en Vivo; rechaza un parche que empieza en 5 h', async () => {
    const futbol = await create();
    expect(futbol.status).toBe(201);
    futbolId = futbol.body.eventId;

    const live = await create({ title: 'Jazz improvisado', category: 'musical', isLive: true, startsAt: inHours(0.5), endsAt: inHours(3), venue: { name: 'Café', address: 'Candelaria', location: CANDELARIA } });
    expect(live.status).toBe(201);
    expect(live.body.isLive).toBe(true);
    jazzId = live.body.eventId;
    expectValid('event.published', (await outbox('event.published')).at(-1));

    const late = await create({ isLive: true, startsAt: inHours(5), endsAt: inHours(6) });
    expect(late.status).toBe(400);
  });

  it('RF5/RF6: busca por recuadro, cercanía, categoría, texto y solo en vivo', async () => {
    const bbox = await auth(api().get('/events').query({ bbox: '-74.06,4.77,-74.03,4.80' }));
    expect(bbox.body.items.map((e) => e.eventId)).toEqual([futbolId]);

    const near = await auth(api().get('/events').query({ lat: CANDELARIA.lat, lng: CANDELARIA.lng, radiusKm: 2 }));
    expect(near.body.items.map((e) => e.eventId)).toEqual([jazzId]);
    expect(near.body.items[0].distanceMeters).toBeLessThan(100);

    const cat = await auth(api().get('/events').query({ category: 'musical,cultural' }));
    expect(cat.body.items.map((e) => e.eventId)).toEqual([jazzId]);

    const text = await auth(api().get('/events').query({ q: 'microfút' }));
    expect(text.body.items.map((e) => e.eventId)).toEqual([futbolId]);

    const live = await auth(api().get('/events').query({ live: 'true' }));
    expect(live.body.items.map((e) => e.eventId)).toEqual([jazzId]);

    expect((await auth(api().get('/events').query({ bbox: 'malo' }))).status).toBe(400);
  });

  it('RF5: clústeres por zona', async () => {
    const res = await auth(api().get('/events/clusters').query({ zoom: 3 }));
    expect(res.status).toBe(200);
    expect(res.body.items.reduce((n, c) => n + c.count, 0)).toBe(2);
  });

  it('RF7: el conteo de booking llena el cupo y publica event.sold_out una vez', async () => {
    const base = { attendanceId: crypto.randomUUID(), eventId: futbolId, eventTitle: 'x', eventStartsAt: inHours(24), userId: ORGANIZER, source: 'rsvp', passIds: [crypto.randomUUID()], confirmedAt: new Date().toISOString() };
    await run('attendance.confirmed', { ...base, attendeeCount: 1 });
    await run('attendance.confirmed', { ...base, attendeeCount: 2 });
    await run('attendance.confirmed', { ...base, attendeeCount: 2 });
    const soldOut = await outbox('event.sold_out');
    expect(soldOut).toHaveLength(1);
    expectValid('event.sold_out', soldOut[0]);
    const detail = await auth(api().get(`/events/${futbolId}`));
    expect(detail.body).toMatchObject({ attendeeCount: 2, soldOut: true });
  });

  it('RF14: ocultar y restaurar por moderación publica event.updated', async () => {
    await run('moderation.event_hidden', { eventId: futbolId, reason: 'spam', decidedBy: ORGANIZER, decidedAt: new Date().toISOString() });
    expect((await auth(api().get('/events'))).body.items.map((e) => e.eventId)).not.toContain(futbolId);
    const hidden = (await outbox('event.updated')).at(-1);
    expect(hidden.status).toBe('hidden');
    expectValid('event.updated', hidden);

    await run('moderation.event_restored', { eventId: futbolId, decidedBy: ORGANIZER, decidedAt: new Date().toISOString() });
    expect((await auth(api().get('/events'))).body.items.map((e) => e.eventId)).toContain(futbolId);
  });

  it('RF14: suspender al organizador oculta sus eventos y reactivarlo los devuelve', async () => {
    await run('moderation.user_suspended', { userId: ORGANIZER, reason: 'fraude', decidedBy: ORGANIZER, decidedAt: new Date().toISOString() });
    expect((await auth(api().get('/events'))).body.items).toHaveLength(0);
    await run('moderation.user_reinstated', { userId: ORGANIZER, decidedBy: ORGANIZER, decidedAt: new Date().toISOString() });
    expect((await auth(api().get('/events'))).body.items).toHaveLength(2);
  });

  it('engagement: vistas y compartidos', async () => {
    expect((await auth(api().post(`/events/${jazzId}/views`)).send({ source: 'map' })).status).toBe(202);
    const share = await auth(api().post(`/events/${jazzId}/shares`));
    expect(share.body.shareUrl).toContain(jazzId);
    expect(await outbox('engagement.viewed')).toHaveLength(1);
    expectValid('engagement.shared', (await outbox('engagement.shared'))[0]);
  });

  it('RF19: el parche expira solo al terminar y sale del mapa', async () => {
    await pool.query(`UPDATE events SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 minute' WHERE id = $1`, [jazzId]);
    expect(await lifecycle.expireFinishedEvents()).toBe(1);
    const expired = await outbox('event.expired');
    expect(expired[0]).toMatchObject({ eventId: jazzId, isLive: true });
    expectValid('event.expired', expired[0]);
    expect((await auth(api().get('/events').query({ live: 'true' }))).body.items).toHaveLength(0);
  });
});
