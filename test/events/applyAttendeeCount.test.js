// Orden del conteo de asistentes por attendanceVersion (booking-service): solo una versión mayor se aplica.
import { describe, expect, it, vi } from 'vitest';
import { applyAttendeeCount } from '../../src/events/lifecycle.js';

function fakeClient(storedVersion) {
  const calls = [];
  const client = {
    calls,
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT attendee_count_version')) return { rows: [{ attendee_count_version: storedVersion }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  return client;
}

const writes = (client) => client.calls.filter((c) => c.sql.startsWith('UPDATE events SET attendee_count'));

describe('applyAttendeeCount: versión del conteo', () => {
  it('aplica una versión mayor que la guardada y guarda la versión', async () => {
    const client = fakeClient(4);
    await applyAttendeeCount(client, 'e1', 12, '2026-11-19T10:00:00Z', 'c1', 5);
    expect(writes(client)).toHaveLength(1);
    expect(writes(client)[0].params).toEqual(['e1', 12, '2026-11-19T10:00:00Z', 5]);
  });

  it('ignora una versión igual o menor, aunque su hora sea posterior', async () => {
    const client = fakeClient(5);
    await applyAttendeeCount(client, 'e1', 9, '2026-11-19T11:00:00Z', 'c1', 5);
    await applyAttendeeCount(client, 'e1', 8, '2026-11-19T12:00:00Z', 'c1', 3);
    expect(writes(client)).toHaveLength(0);
  });

  it('no escribe si el evento no existe', async () => {
    const client = { calls: [], query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    await applyAttendeeCount(client, 'e-no', 1, '2026-11-19T10:00:00Z', 'c1', 1);
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
