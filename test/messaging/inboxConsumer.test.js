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

describe('handler account.deleted', () => {
  it('cancela los eventos futuros del organizador y publica event.cancelled por cada uno', async () => {
    const pendingEvent = { id: 'evt-1', title: 'Noche de jazz', version: 2 };
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [pendingEvent] }) // SELECT eventos a cancelar
        .mockResolvedValueOnce({ rows: [] }) // UPDATE events SET status='cancelled'...
        .mockResolvedValueOnce({ rows: [] }) // INSERT INTO outbox (enqueue)
        .mockResolvedValueOnce({ rows: [] }), // UPDATE events SET organizer_name=...
    };
    const data = { userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', deletedAt: '2026-12-01T10:00:00Z' };
    const envelope = { eventId: 'eventid-del-account-deleted', eventType: 'account.deleted', data };

    await _internal.handlers['account.deleted'](data, client, envelope);

    expect(client.query).toHaveBeenCalledTimes(4);

    const [selectSql, selectParams] = client.query.mock.calls[0];
    expect(selectSql).toMatch(/SELECT id, title, version FROM events/);
    expect(selectParams).toEqual([data.userId]);

    const [cancelSql, cancelParams] = client.query.mock.calls[1];
    expect(cancelSql).toMatch(/UPDATE events SET status = 'cancelled'/);
    expect(cancelParams).toEqual([pendingEvent.id, pendingEvent.version + 1]);

    const [outboxSql, outboxParams] = client.query.mock.calls[2];
    expect(outboxSql).toMatch(/INSERT INTO outbox/);
    expect(JSON.parse(outboxParams[2])).toMatchObject({
      eventId: pendingEvent.id,
      organizerId: data.userId,
      title: pendingEvent.title,
      version: pendingEvent.version + 1,
    });
    // El evento publicado nace de CONSUMIR account.deleted, no de una petición HTTP: lleva
    // causationId (el eventId de ese mensaje), no correlationId.
    expect(outboxParams[3]).toBeNull();
    expect(outboxParams[4]).toBe(envelope.eventId);

    const [anonymizeSql, anonymizeParams] = client.query.mock.calls[3];
    expect(anonymizeSql).toMatch(/UPDATE events SET organizer_name = 'Organizador eliminado'/);
    expect(anonymizeParams).toEqual([data.userId]);
  });

  it('igual anonimiza aunque no tenga eventos futuros que cancelar', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // SELECT: nada que cancelar
        .mockResolvedValueOnce({ rows: [] }), // UPDATE organizer_name
    };
    const data = { userId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', deletedAt: '2026-12-01T10:00:00Z' };

    await _internal.handlers['account.deleted'](data, client, { eventId: 'x' });

    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
