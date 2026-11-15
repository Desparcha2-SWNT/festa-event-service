// El publicador de outbox no debe detenerse si falla la conexión a la base: se reintenta en el siguiente tick.
import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('../../src/db/pool.js', () => ({ pool: { connect: db.connect } }));
vi.mock('../../src/logger.js', () => ({ logger: { error: () => {}, warn: () => {}, info: () => {} } }));

const { startOutboxPublisher } = await import('../../src/messaging/outboxPublisher.js');

describe('startOutboxPublisher', () => {
  it('si pool.connect falla, sigue programando ticks y no deja rechazos sin manejar', async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
    db.connect.mockReset().mockRejectedValueOnce(new Error('db caída')).mockResolvedValue(client);
    const connection = { createConfirmChannel: vi.fn(async () => ({ publish: vi.fn() })) };

    const publisher = startOutboxPublisher(connection, { intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    publisher.stop();

    expect(db.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(client.release).toHaveBeenCalled();
  });
});
