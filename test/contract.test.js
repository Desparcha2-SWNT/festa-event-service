// Contract test: lo que arma toApi() (y por tanto lo que se guarda en el outbox como `data`
// de event.published) debe cumplir el esquema real de festa-infra. Si alguien cambia el
// esquema o la forma del API sin avisar al otro, esta prueba falla.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { toApi } from '../src/events/repository.js';

const contractsDir = process.env.FESTA_CONTRACTS_DIR ?? path.resolve('../festa-infra/contracts');
const schemaPath = path.join(contractsDir, 'events/event/event.published.schema.json');
const hasContracts = fs.existsSync(schemaPath);

const row = {
  id: '6f1c2b8e-3a1d-4c3e-9b0a-1f2e3d4c5b6a',
  organizer_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  organizer_type: 'merchant',
  merchant_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  organizer_name: 'Café Bohemio',
  title: 'Noche de jazz en La Candelaria',
  description: 'Una noche de jazz en vivo.',
  description_ai_generated: true,
  category: 'musical',
  tags: ['jazz', 'en vivo'],
  starts_at: new Date('2026-11-07T01:00:00Z'),
  ends_at: new Date('2026-11-07T04:00:00Z'),
  venue_name: 'Café Bohemio',
  venue_address: 'Cl. 11 #3-45, Bogotá',
  lat: 4.5981,
  lng: -74.0758,
  capacity: 80,
  ticketed: true,
  price_cents: 2500000,
  max_tickets_per_order: 4,
  currency: 'COP',
  featured: false,
  is_live: false,
  cover_image_url: null,
  status: 'published',
  version: 1,
  updated_at: new Date('2026-10-28T15:00:00Z'),
};

describe.skipIf(!hasContracts)('event.published cumple el contrato de festa-infra', () => {
  it('toApi(row) valida contra el esquema', () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);

    const valid = validate(toApi(row));
    expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
    expect(valid).toBe(true);
  });
});

if (!hasContracts) {
  console.warn(`[contract.test] no se encontró ${schemaPath}; clona festa-infra como hermano de este repo o define FESTA_CONTRACTS_DIR`);
}
