// No hay Postgres real en las pruebas: esto no corre las migraciones de verdad, verifica que
// migrate() pida el advisory lock ANTES de tocar schema_migrations y lo suelte al final —
// que es justo lo que evita que dos réplicas arrancando a la vez apliquen la misma migración.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/pool.js', () => {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  return { pool: { connect: vi.fn().mockResolvedValue(client) } };
});

const { pool } = await import('../../src/db/pool.js');
const { migrate } = await import('../../src/db/migrate.js');

describe('migrate', () => {
  it('toma el advisory lock antes de todo y lo suelta al final', async () => {
    const client = await pool.connect();
    client.query.mockClear();

    await migrate();

    const calls = client.query.mock.calls.map(([sql]) => sql);
    const lockIndex = calls.findIndex((sql) => sql.includes('pg_advisory_lock'));
    const unlockIndex = calls.findIndex((sql) => sql.includes('pg_advisory_unlock'));

    expect(lockIndex).toBe(0); // lo primero que se pide, antes de crear schema_migrations
    expect(unlockIndex).toBe(calls.length - 1); // lo último, pase lo que pase
    expect(client.query.mock.calls[0][1]).toEqual(client.query.mock.calls[unlockIndex][1]); // misma key
  });
});
