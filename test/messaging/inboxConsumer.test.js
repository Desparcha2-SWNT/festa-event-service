import { describe, expect, it, vi } from 'vitest';
import { _internal } from '../../src/messaging/inboxConsumer.js';

describe('handler merchant.verified', () => {
  it('inserta (o actualiza) el comercio en verified_merchants, con su dueño', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const data = {
      merchantId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      businessName: 'Café Bohemio',
      verifiedAt: '2026-10-25T09:00:00Z',
    };

    await _internal.handlers['merchant.verified'](data, client);

    expect(client.query).toHaveBeenCalledOnce();
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO verified_merchants/);
    expect(sql).toMatch(/ON CONFLICT \(merchant_id\) DO UPDATE/);
    // user_id va en la fila Y se actualiza en el ON CONFLICT: si el admin re-verifica el
    // comercio bajo otro dueño, la proyección debe reflejar al dueño actual.
    expect(params).toEqual([data.merchantId, data.userId, data.businessName, data.verifiedAt]);
  });
});

// Fila completa tal como la devolvería `UPDATE ... RETURNING *, ST_X(...) AS lng, ST_Y(...) AS lat`:
// lo que toApi() necesita para armar el event.updated.
function anonymizedRow(overrides = {}) {
  return {
    id: 'evt-pasado-1',
    organizer_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    organizer_type: 'user',
    merchant_id: null,
    organizer_name: 'Organizador eliminado',
    title: 'Picnic en el parque',
    description: 'Un picnic tranquilo.',
    description_ai_generated: false,
    category: 'cultural',
    tags: [],
    starts_at: new Date('2026-01-01T10:00:00Z'),
    ends_at: new Date('2026-01-01T12:00:00Z'),
    venue_name: 'Parque Simón Bolívar',
    venue_address: 'Cra. 60 # 63-11, Bogotá',
    lat: 4.6584,
    lng: -74.0937,
    capacity: null,
    ticketed: false,
    price_cents: 0,
    max_tickets_per_order: null,
    currency: 'COP',
    featured: false,
    is_live: false,
    cover_image_url: null,
    status: 'expired',
    version: 2,
    updated_at: new Date('2026-12-01T10:00:00Z'),
    ...overrides,
  };
}

describe('handler account.deleted', () => {
  it('cancela los eventos futuros, anonimiza versionado (publicando event.updated) y borra el comercio', async () => {
    const pendingEvent = { id: 'evt-futuro-1', title: 'Noche de jazz', version: 2 };
    const pastRow = anonymizedRow();
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [pendingEvent] }) // SELECT eventos futuros a cancelar
        .mockResolvedValueOnce({ rows: [] }) // UPDATE events SET status='cancelled'...
        .mockResolvedValueOnce({ rows: [] }) // INSERT INTO outbox (event.cancelled)
        .mockResolvedValueOnce({ rows: [pastRow] }) // UPDATE organizer_name ... RETURNING
        .mockResolvedValueOnce({ rows: [] }) // INSERT INTO outbox (event.updated)
        .mockResolvedValueOnce({ rows: [] }), // DELETE FROM verified_merchants
    };
    const data = { userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', deletedAt: '2026-12-01T10:00:00Z' };
    const envelope = { eventId: 'eventid-del-account-deleted', eventType: 'account.deleted', data };

    await _internal.handlers['account.deleted'](data, client, envelope);

    expect(client.query).toHaveBeenCalledTimes(6);

    const [selectSql, selectParams] = client.query.mock.calls[0];
    expect(selectSql).toMatch(/SELECT id, title, version FROM events/);
    expect(selectParams).toEqual([data.userId]);

    const [cancelSql, cancelParams] = client.query.mock.calls[1];
    expect(cancelSql).toMatch(/UPDATE events SET status = 'cancelled'/);
    expect(cancelParams).toEqual([pendingEvent.id, pendingEvent.version + 1]);

    const [cancelOutboxSql, cancelOutboxParams] = client.query.mock.calls[2];
    expect(cancelOutboxSql).toMatch(/INSERT INTO outbox/);
    expect(JSON.parse(cancelOutboxParams[2])).toMatchObject({
      eventId: pendingEvent.id,
      organizerId: data.userId,
      title: pendingEvent.title,
      version: pendingEvent.version + 1,
    });
    // Nace de CONSUMIR account.deleted, no de una petición HTTP: lleva causationId, no correlationId.
    expect(cancelOutboxParams[3]).toBeNull();
    expect(cancelOutboxParams[4]).toBe(envelope.eventId);

    const [anonymizeSql, anonymizeParams] = client.query.mock.calls[3];
    expect(anonymizeSql).toMatch(/UPDATE events SET organizer_name = 'Organizador eliminado', version = version \+ 1/);
    expect(anonymizeSql).toMatch(/RETURNING/);
    expect(anonymizeParams).toEqual([data.userId]);

    const [updatedOutboxSql, updatedOutboxParams] = client.query.mock.calls[4];
    expect(updatedOutboxSql).toMatch(/INSERT INTO outbox/);
    const updatedPayload = JSON.parse(updatedOutboxParams[2]);
    expect(updatedPayload).toMatchObject({
      eventId: pastRow.id,
      organizerName: 'Organizador eliminado',
      version: pastRow.version, // ya viene incrementada por el UPDATE
    });
    expect(updatedOutboxParams[4]).toBe(envelope.eventId); // causationId, mismo mensaje causante

    const [deleteMerchantSql, deleteMerchantParams] = client.query.mock.calls[5];
    expect(deleteMerchantSql).toMatch(/DELETE FROM verified_merchants/);
    expect(deleteMerchantParams).toEqual([data.userId]);
  });

  it('igual anonimiza (versionado) y borra la proyección de comercio aunque no tenga eventos futuros que cancelar', async () => {
    const row = anonymizedRow({ id: 'evt-pasado-2' });
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // SELECT: nada que cancelar
        .mockResolvedValueOnce({ rows: [row] }) // UPDATE organizer_name ... RETURNING
        .mockResolvedValueOnce({ rows: [] }) // INSERT INTO outbox (event.updated)
        .mockResolvedValueOnce({ rows: [] }), // DELETE FROM verified_merchants
    };
    const data = { userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', deletedAt: '2026-12-01T10:00:00Z' };

    await _internal.handlers['account.deleted'](data, client, { eventId: 'x' });

    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls[1][0]).toMatch(/RETURNING/);
    expect(client.query.mock.calls[2][0]).toMatch(/INSERT INTO outbox/);
    expect(client.query.mock.calls[3][0]).toMatch(/DELETE FROM verified_merchants/);
  });

  it('no publica event.updated si no hay nada que anonimizar', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // SELECT: nada que cancelar
        .mockResolvedValueOnce({ rows: [] }) // UPDATE organizer_name ... RETURNING (ninguna fila)
        .mockResolvedValueOnce({ rows: [] }), // DELETE FROM verified_merchants
    };
    const data = { userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', deletedAt: '2026-12-01T10:00:00Z' };

    await _internal.handlers['account.deleted'](data, client, { eventId: 'x' });

    expect(client.query).toHaveBeenCalledTimes(3);
  });
});
