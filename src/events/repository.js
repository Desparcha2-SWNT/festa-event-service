import { pool, withTransaction } from '../db/pool.js';
import { enqueue } from '../messaging/outboxRepository.js';

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
 * (ver contracts/README.md § Publicar — transactional outbox). `correlationId` es el
 * X-Correlation-ID de la petición HTTP (lo pone Kong), para poder rastrear la cadena completa.
 */
export async function createEvent(input, organizerId, correlationId) {
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

    await enqueue(client, { exchange: 'festa.event', routingKey: 'event.published', payload: api, correlationId });

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
 * (auth-service deja elegirlo al registrarse); no que un admin lo verificó, ni que ESE
 * merchantId sea del usuario autenticado. Esta proyección (migrations/004_verified_merchants.sql,
 * llenada por el handler de merchant.verified) es la única fuente confiable de ambas cosas:
 * sin comprobar `user_id`, cualquier merchant verificado podría crear eventos a nombre de otro.
 */
export async function isMerchantOwnedAndVerified(merchantId, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM verified_merchants WHERE merchant_id = $1 AND user_id = $2',
    [merchantId, userId],
  );
  return rows.length > 0;
}

/**
 * Regla de SCRUM-69: solo quien creó el evento puede editarlo o cancelarlo. Devuelve el motivo
 * por el que `userId` no puede tocar la fila, o null si puede. La edición (SCRUM-67) usa la misma regla.
 */
export function ownershipError(row, userId) {
  if (!row) return 'not_found';
  if (row.organizer_id !== userId) return 'forbidden';
  return null;
}

export function toCancelledMessage(event, reason) {
  return {
    eventId: event.eventId,
    organizerId: event.organizerId,
    title: event.title,
    reason,
    cancelledAt: event.updatedAt,
    version: event.version,
  };
}

/**
 * Cancela el evento y, en la misma transacción, encola `event.cancelled` (booking revoca los pases
 * y payment pide los reembolsos). El FOR UPDATE evita que dos cancelaciones simultáneas publiquen
 * el mensaje dos veces. Solo se cancela un evento publicado que aún no ha terminado.
 */
export async function cancelEvent(id, userId, reason, correlationId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [id]);
    const current = rows[0];

    const denied = ownershipError(current, userId);
    if (denied) return { outcome: denied };
    if (current.status !== 'published' || current.ends_at <= new Date()) return { outcome: 'conflict' };

    const updated = await client.query(
      `UPDATE events SET status = 'cancelled', version = version + 1, updated_at = now()
       WHERE id = $1
       RETURNING *,
         ST_X(venue_location::geometry) AS lng, ST_Y(venue_location::geometry) AS lat`,
      [id],
    );
    const event = toApi(updated.rows[0]);

    await enqueue(client, {
      exchange: 'festa.event',
      routingKey: 'event.cancelled',
      payload: toCancelledMessage(event, reason),
      correlationId,
    });

    return { outcome: 'cancelled', event };
  });
}

const SELECT_EVENT = `SELECT *, ST_X(venue_location::geometry) AS lng, ST_Y(venue_location::geometry) AS lat
  FROM events`;

/**
 * Eventos creados por `userId`, en todos los estados, del más reciente al más antiguo
 * («Mis eventos» en la app). El límite basta para el piloto; si crece, se pagina.
 */
export async function findEventsByOrganizer(userId) {
  const { rows } = await pool.query(`${SELECT_EVENT} WHERE organizer_id = $1 ORDER BY starts_at DESC LIMIT 100`, [
    userId,
  ]);
  return rows.map(toApi);
}

/** Cambio crítico para quienes ya confirmaron: otra hora de inicio u otro lugar. */
function isRescheduled(before, after) {
  return before.startsAt !== after.startsAt || JSON.stringify(before.venue) !== JSON.stringify(after.venue);
}

export function toRescheduledMessage(before, event) {
  return {
    eventId: event.eventId,
    title: event.title,
    previousStartsAt: before.startsAt,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    previousVenue: before.venue,
    venue: event.venue,
    version: event.version,
    rescheduledAt: event.updatedAt,
  };
}

/**
 * SCRUM-67: aplica `changes` (ya validados con updateEventSchema) al evento y, en la misma
 * transacción, encola `event.updated` con el evento completo. Si cambió la hora de inicio o el
 * lugar, encola además `event.rescheduled` para que notification avise a los asistentes.
 * Misma regla que cancelar: solo el creador, y solo un evento publicado que no ha terminado.
 */
export async function updateEvent(id, userId, changes, correlationId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`${SELECT_EVENT} WHERE id = $1 FOR UPDATE`, [id]);
    const current = rows[0];

    const denied = ownershipError(current, userId);
    if (denied) return { outcome: denied };
    if (current.status !== 'published' || current.ends_at <= new Date()) return { outcome: 'conflict' };

    const before = toApi(current);
    const after = { ...before, ...changes };
    // Mismo formato que toApi, para comparar fechas sin importar cómo llegaron escritas.
    after.startsAt = new Date(after.startsAt).toISOString();
    after.endsAt = new Date(after.endsAt).toISOString();
    if (after.endsAt <= after.startsAt) return { outcome: 'invalid_dates' };

    const updated = await client.query(
      `UPDATE events SET
         title = $2, description = $3, description_ai_generated = $4, category = $5,
         starts_at = $6, ends_at = $7, venue_name = $8, venue_address = $9,
         venue_location = ST_SetSRID(ST_MakePoint($10, $11), 4326), capacity = $12,
         version = version + 1, updated_at = now()
       WHERE id = $1
       RETURNING *,
         ST_X(venue_location::geometry) AS lng, ST_Y(venue_location::geometry) AS lat`,
      [
        id,
        after.title,
        after.description,
        after.descriptionAiGenerated,
        after.category,
        after.startsAt,
        after.endsAt,
        after.venue.name,
        after.venue.address,
        after.venue.location.lng,
        after.venue.location.lat,
        after.capacity,
      ],
    );
    const event = toApi(updated.rows[0]);

    await enqueue(client, { exchange: 'festa.event', routingKey: 'event.updated', payload: event, correlationId });
    if (isRescheduled(before, after)) {
      await enqueue(client, {
        exchange: 'festa.event',
        routingKey: 'event.rescheduled',
        payload: toRescheduledMessage(before, event),
        correlationId,
      });
    }

    return { outcome: 'updated', event };
  });
}
