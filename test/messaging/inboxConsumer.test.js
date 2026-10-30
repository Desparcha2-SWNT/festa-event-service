import { describe, expect, it, vi } from 'vitest';
import { _internal } from '../../src/messaging/inboxConsumer.js';

describe('handler merchant.verified', () => {
  it('inserta (o actualiza) el comercio en verified_merchants', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const data = {
      merchantId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      businessName: 'Café Bohemio',
      verifiedAt: '2026-10-25T09:00:00Z',
    };

    await _internal.handlers['merchant.verified'](data, client);

    expect(client.query).toHaveBeenCalledOnce();
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO verified_merchants/);
    expect(sql).toMatch(/ON CONFLICT \(merchant_id\) DO UPDATE/);
    expect(params).toEqual([data.merchantId, data.businessName, data.verifiedAt]);
  });
});
