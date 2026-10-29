import { describe, expect, it } from 'vitest';
import { createEventSchema } from '../src/events/validation.js';

const base = {
  organizerType: 'merchant',
  organizerName: 'Café Bohemio',
  title: 'Noche de jazz',
  description: 'Una noche de jazz en vivo.',
  category: 'musical',
  startsAt: '2026-11-07T01:00:00Z',
  endsAt: '2026-11-07T04:00:00Z',
  venue: { name: 'Café Bohemio', address: 'Cl. 11 #3-45, Bogotá', location: { lat: 4.5981, lng: -74.0758 } },
  ticketed: true,
  priceCents: 2500000,
};

describe('createEventSchema', () => {
  it('acepta un evento válido', () => {
    expect(createEventSchema.safeParse(base).success).toBe(true);
  });

  it('rechaza endsAt antes de startsAt', () => {
    const result = createEventSchema.safeParse({ ...base, endsAt: '2026-11-06T00:00:00Z' });
    expect(result.success).toBe(false);
  });

  it('rechaza que un usuario (no merchant) venda boletas', () => {
    const result = createEventSchema.safeParse({ ...base, organizerType: 'user', ticketed: true });
    expect(result.success).toBe(false);
  });

  it('rechaza priceCents > 0 si no es ticketed', () => {
    const result = createEventSchema.safeParse({ ...base, ticketed: false, priceCents: 1000 });
    expect(result.success).toBe(false);
  });

  it('rechaza coordenadas fuera de rango', () => {
    const result = createEventSchema.safeParse({
      ...base,
      venue: { ...base.venue, location: { lat: 200, lng: 0 } },
    });
    expect(result.success).toBe(false);
  });

  it('rellena los valores por defecto (tags, descriptionAiGenerated)', () => {
    const result = createEventSchema.safeParse(base);
    expect(result.data.tags).toEqual([]);
    expect(result.data.descriptionAiGenerated).toBe(false);
  });
});
