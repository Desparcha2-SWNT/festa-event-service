import { pool, withTransaction } from '../db/pool.js';

function toRow(input) {
  return {
    organizer_type: input.organizerType,
    merchant_id: input.merchantId ?? null,
    organizer_name: input.organizerName,
    title: input.title,
    description: input.description,
    description_ai_generated: input.descriptionAiGenerated,
    category: input.category,
    tags: input.tags,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    venue_name: input.venue.name,
    venue_address: input.venue.address,
    lng: input.venue.location.lng,
    lat: input.venue.location.lat,
    capacity: input.capacity ?? null,
    ticketed: input.ticketed,
    price_cents: input.priceCents,
    max_tickets_per_order: input.maxTicketsPerOrder ?? null,
    cover_image_url: input.coverImageUrl ?? null,
  };
}

export function toApi(row) {
  return {
    eventId: row.id,
    organizerId: row.organizer_id,
    organizerType: row.organizer_type,
    merchantId: row.merchant_id ?? undefined,
    organizerName: row.organizer_name,
    title: row.title,
    description: row.description,
    descriptionAiGenerated: row.description_ai_generated,
    category: row.category,
    tags: row.tags,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    venue: {
      name: row.venue_name,
      address: row.venue_address,
      location: { lat: row.lat, lng: row.lng },
    },
    capacity: row.capacity,
    ticketed: row.ticketed,
    priceCents: row.price_cents,
    maxTicketsPerOrder: row.max_tickets_per_order ?? undefined,
    currency: row.currency,
    featured: row.featured,
    isLive: row.is_live,
    coverImageUrl: row.cover_image_url,
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Inserta el evento y, en la misma transacción, la fila de outbox para `event.published`
 * (ver contracts/README.md § Publicar — transactional outbox).
 */
export async function createEvent(input, organizerId) {
  const r = toRow(input);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO events (
         organizer_id, organizer_type, merchant_id, organizer_name, title, description,
         description_ai_generated, category, tags, starts_at, ends_at,
         venue_name, venue_address, venue_location,
         capacity, ticketed, price_cents, max_tickets_per_order, cover_image_url
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         ST_SetSRID(ST_MakePoint($14, $15), 4326),
         $16, $17, $18, $19, $20
       )
       RETURNING *,
         ST_X(venue_location::geometry) AS lng, ST_Y(venue_location::geometry) AS lat`,
      [
        organizerId,
        r.organizer_type,
        r.merchant_id,
        r.organizer_name,
        r.title,
        r.description,
        r.description_ai_generated,
        r.category,
        r.tags,
        r.starts_at,
        r.ends_at,
        r.venue_name,
        r.venue_address,
        r.lng,
        r.lat,
        r.capacity,
        r.ticketed,
        r.price_cents,
        r.max_tickets_per_order,
        r.cover_image_url,
      ],
    );
    const row = rows[0];
    const api = toApi(row);

    await client.query(
      `INSERT INTO outbox (exchange, routing_key, payload) VALUES ($1, $2, $3)`,
      ['festa.event', 'event.published', JSON.stringify(api)],
    );

    return api;
  });
}

export async function findEventById(id) {
  const { rows } = await pool.query(
    `SELECT *, ST_X(venue_location::geometry) AS lng, ST_Y(venue_location::geometry) AS lat
     FROM events WHERE id = $1`,
    [id],
  );
  return rows[0] ? toApi(rows[0]) : null;
}

/**
 * El claim "role: merchant" del JWT solo dice que la cuenta se registró como comercio
 * (auth-service deja elegirlo al registrarse); no que un admin lo verificó. Esta proyección
 * (migrations/004_verified_merchants.sql, llenada por el handler de merchant.verified) es la
 * única fuente confiable de "puede vender boletas".
 */
export async function isMerchantVerified(merchantId) {
  const { rows } = await pool.query('SELECT 1 FROM verified_merchants WHERE merchant_id = $1', [merchantId]);
  return rows.length > 0;
}
