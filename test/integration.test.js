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
    await run('attendance.confirmed', { ...base, attendeeCount: 1, attendanceVersion: 1 });
    await run('attendance.confirmed', { ...base, attendeeCount: 2, attendanceVersion: 2 });
    await run('attendance.confirmed', { ...base, attendeeCount: 2, attendanceVersion: 3 });
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

  it('RF7: un attendance.* atrasado no pisa un conteo más nuevo ni limpia sold_out', async () => {
    // La versión decide el orden, no la hora: un cambio atrasado trae una versión menor que la guardada.
    const cancelled = (attendeeCount, attendanceVersion, cancelledAt) =>
      run('attendance.cancelled', { attendanceId: crypto.randomUUID(), eventId: futbolId, userId: ORGANIZER, reason: 'user', revokedPassIds: [], attendeeCount, attendanceVersion, cancelledAt });
    await cancelled(0, 2, new Date(Date.now() - 3600_000).toISOString());
    expect((await auth(api().get(`/events/${futbolId}`))).body).toMatchObject({ attendeeCount: 2, soldOut: true });

    await cancelled(1, 4, new Date().toISOString());
    expect((await auth(api().get(`/events/${futbolId}`))).body).toMatchObject({ attendeeCount: 1, soldOut: false });
  });

  it('PATCH del cupo reconcilia sold_out: bajarlo al conteo avisa; subirlo libera y el siguiente llenado vuelve a avisar', async () => {
    expect((await auth(api().patch(`/events/${futbolId}`)).send({ capacity: 1 })).status).toBe(200);
    expect(await outbox('event.sold_out')).toHaveLength(2);
    expect((await pool.query('SELECT sold_out_at FROM events WHERE id = $1', [futbolId])).rows[0].sold_out_at).not.toBeNull();

    expect((await auth(api().patch(`/events/${futbolId}`)).send({ capacity: 2 })).status).toBe(200);
    expect((await pool.query('SELECT sold_out_at FROM events WHERE id = $1', [futbolId])).rows[0].sold_out_at).toBeNull();
    await run('attendance.confirmed', { attendanceId: crypto.randomUUID(), eventId: futbolId, eventTitle: 'x', eventStartsAt: inHours(24), userId: ORGANIZER, source: 'rsvp', passIds: [crypto.randomUUID()], attendeeCount: 2, attendanceVersion: 5, confirmedAt: new Date().toISOString() });
    expect(await outbox('event.sold_out')).toHaveLength(3);
  });

  it('PATCH revalida: no deja mover un evento al pasado ni alargar un parche a más de 8 h', async () => {
    const past = await auth(api().patch(`/events/${futbolId}`)).send({ startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-01-01T02:00:00Z' });
    expect(past.status).toBe(400);
    const long = await auth(api().patch(`/events/${jazzId}`)).send({ endsAt: inHours(12) });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe('un Parche en Vivo dura máximo 8 horas');
  });

  it('RF14: ocultar el evento y suspender al organizador son restricciones independientes', async () => {
    const visible = async () => (await auth(api().get('/events'))).body.items.map((e) => e.eventId);
    const decided = (offsetMs = 0) => ({ userId: ORGANIZER, reason: 'x', decidedBy: ORGANIZER, decidedAt: new Date(Date.now() + offsetMs).toISOString() });

    // Ocultado por decisión sobre el evento: reactivar la cuenta no lo devuelve.
    await run('moderation.event_hidden', { eventId: futbolId, reason: 'spam', decidedBy: ORGANIZER, decidedAt: new Date().toISOString() });
    await run('moderation.user_suspended', decided());
    await run('moderation.user_reinstated', decided(1));
    expect(await visible()).toEqual(expect.not.arrayContaining([futbolId]));
    expect(await visible()).toContain(jazzId);

    // Restaurar el evento mientras su organizador sigue suspendido no lo publica.
    await run('moderation.user_suspended', decided(2));
    await run('moderation.event_restored', { eventId: futbolId, decidedBy: ORGANIZER, decidedAt: new Date().toISOString() });
    expect(await visible()).toEqual([]);
    await run('moderation.user_reinstated', decided(3));
    expect(await visible()).toEqual(expect.arrayContaining([futbolId, jazzId]));
  });

  it('RF14: una cuenta suspendida no crea eventos aunque su JWT siga vigente; una reactivación atrasada se ignora', async () => {
    const decided = (offsetMs) => ({ userId: ORGANIZER, reason: 'x', decidedBy: ORGANIZER, decidedAt: new Date(Date.now() + offsetMs).toISOString() });
    await run('moderation.user_suspended', decided(10_000));
    expect((await create()).status).toBe(403);

    await run('moderation.user_reinstated', decided(-3600_000));
    expect((await create()).status).toBe(403);
    expect((await auth(api().get('/events'))).body.items).toHaveLength(0);

    await run('moderation.user_reinstated', decided(20_000));
    const created = await create({ title: 'Tarde de Jazz', tags: ['Jazz', 'Vinilo'] });
    expect(created.status).toBe(201);
  });

  it('RF6: la etiqueta se busca sin importar mayúsculas y "gratis" incluye boletas de precio 0', async () => {
    for (const q of ['jazz', 'JAZZ', 'Vinilo']) {
      const res = await auth(api().get('/events').query({ q }));
      expect(res.body.items.map((e) => e.title), q).toContain('Tarde de Jazz');
    }

    await pool.query(`UPDATE events SET organizer_type = 'merchant', merchant_id = gen_random_uuid(), ticketed = true, price_cents = 0 WHERE id = $1`, [futbolId]);
    const free = await auth(api().get('/events').query({ free: 'true' }));
    expect(free.body.items.map((e) => e.eventId)).toContain(futbolId);
    const clusters = await auth(api().get('/events/clusters').query({ zoom: 3, free: 'true' }));
    expect(clusters.body.items.reduce((n, c) => n + c.count, 0)).toBe(3);
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
  // ---- Auditoría de seguridad (2026-11-28) ----

  const OTHER = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
  const MERCHANT_USER = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
  const MERCHANT_ID = '3b4c5d6e-7f8a-4b9c-8d0e-1f2a3b4c5d6e';
  const tokenFor = (sub, role = 'user') =>
    jwt.sign({ role }, jwtPrivateKeyPem, { algorithm: 'RS256', issuer: process.env.JWT_ISSUER, subject: sub, expiresIn: '10m' });
  const as = (sub, role) => (r) => r.set('Authorization', `Bearer ${tokenFor(sub, role)}`);
  const createAs = (sub, role, overrides = {}) =>
    as(sub, role)(api().post('/events')).send({
      organizerType: 'user',
      organizerName: 'Ana',
      title: 'Feria de prueba',
      description: 'Ven',
      category: 'cultural',
      startsAt: inHours(24),
      endsAt: inHours(26),
      venue: { name: 'Bloque G', address: 'Autopista Norte km 13', location: ECI },
      ...overrides,
    });

  it('RF14: un evento oculto no se sirve por enlace directo a otro usuario, pero sí a su organizador', async () => {
    await run('moderation.event_hidden', { eventId: futbolId, reason: 'fraude', decidedBy: ORGANIZER, decidedAt: new Date().toISOString() });
    expect((await as(OTHER)(api().get(`/events/${futbolId}`))).status).toBe(404);
    expect((await auth(api().get(`/events/${futbolId}`))).status).toBe(200);
    expect((await as(OTHER, 'admin')(api().get(`/events/${futbolId}`))).status).toBe(200);
    await run('moderation.event_restored', { eventId: futbolId, decidedBy: ORGANIZER, decidedAt: new Date().toISOString() });
    expect((await as(OTHER)(api().get(`/events/${futbolId}`))).status).toBe(200);
  });

  it('organizerName: un comercio publica con su nombre verificado y un usuario no puede usarlo', async () => {
    const verifiedAt = new Date(Date.now() - 60_000).toISOString();
    await run('merchant.verified', { merchantId: MERCHANT_ID, userId: MERCHANT_USER, businessName: 'Café La Escuela', verifiedAt });

    const own = await createAs(MERCHANT_USER, 'merchant', { organizerType: 'merchant', merchantId: MERCHANT_ID, organizerName: 'Otro nombre' });
    expect(own.status).toBe(201);
    expect(own.body.organizerName).toBe('Café La Escuela');

    const fake = await createAs(OTHER, 'user', { organizerName: '  café la escuela ' });
    expect(fake.status).toBe(409);
  });

  it('merchant.updated con verified=false revoca al comercio y un merchant.verified atrasado no lo devuelve', async () => {
    const merchantEvent = { organizerType: 'merchant', merchantId: MERCHANT_ID, organizerName: 'x' };
    await run('merchant.updated', {
      merchantId: MERCHANT_ID,
      userId: MERCHANT_USER,
      businessName: 'Café La Escuela',
      category: 'gastronomico',
      place: { name: 'Bloque G', address: 'Autopista Norte km 13', location: ECI },
      verified: false,
      updatedAt: new Date().toISOString(),
    });
    expect((await createAs(MERCHANT_USER, 'merchant', merchantEvent)).status).toBe(403);
    // Ya revocado, su nombre vuelve a estar libre para un usuario.
    expect((await createAs(OTHER, 'user', { organizerName: 'Café La Escuela' })).status).toBe(201);

    const stale = new Date(Date.now() - 3600_000).toISOString();
    await run('merchant.verified', { merchantId: MERCHANT_ID, userId: MERCHANT_USER, businessName: 'Café La Escuela', verifiedAt: stale });
    expect((await createAs(MERCHANT_USER, 'merchant', merchantEvent)).status).toBe(403);

    await run('merchant.verified', { merchantId: MERCHANT_ID, userId: MERCHANT_USER, businessName: 'Café La Escuela', verifiedAt: new Date(Date.now() + 1000).toISOString() });
    expect((await createAs(MERCHANT_USER, 'merchant', merchantEvent)).status).toBe(201);
  });

  it('tope diario de eventos por organizador: el siguiente responde 429 y no encola event.published', async () => {
    const { config } = await import('../src/config.js');
    const before = config.maxEventsPerOrganizerPerDay;
    config.maxEventsPerOrganizerPerDay = 2;
    try {
      const capped = '5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b';
      expect((await createAs(capped, 'user')).status).toBe(201);
      expect((await createAs(capped, 'user')).status).toBe(201);
      const published = (await outbox('event.published')).length;
      expect((await createAs(capped, 'user')).status).toBe(429);
      expect((await outbox('event.published')).length).toBe(published);
    } finally {
      config.maxEventsPerOrganizerPerDay = before;
    }
  });
});
