import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { enqueue } from '../messaging/outboxRepository.js';
import { isSuspended, lockOrganizer, reconcileSoldOut } from './lifecycle.js';
import { scheduleError } from './validation.js';

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
    is_live: input.isLive ?? false,
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
    // RF14: el JWT de una cuenta suspendida sigue vigente hasta vencer; la suspensión se consulta en
    // la proyección local, con el mismo candado que usa moderation.user_suspended (ver lockOrganizer).
    await lockOrganizer(client, organizerId);
    if (await isSuspended(client, organizerId)) return { outcome: 'suspended' };
    // Bajo el mismo candado del organizador, así dos POST simultáneos no pasan el tope a la vez.
    const { rows: recent } = await client.query(
      `SELECT count(*)::int AS n FROM events WHERE organizer_id = $1 AND created_at > now() - interval '24 hours'`,
      [organizerId],
    );
    if (recent[0].n >= config.maxEventsPerOrganizerPerDay) return { outcome: 'too_many' };

    const { rows } = await client.query(
      `INSERT INTO events (
         organizer_id, organizer_type, merchant_id, organizer_name, title, description,
         description_ai_generated, category, tags, starts_at, ends_at,
         venue_name, venue_address, venue_location,
         capacity, ticketed, price_cents, max_tickets_per_order, cover_image_url, is_live
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         ST_SetSRID(ST_MakePoint($14, $15), 4326),
         $16, $17, $18, $19, $20, $21
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
        r.is_live,
      ],
    );
    const row = rows[0];
    const api = toApi(row);

    await enqueue(client, { exchange: 'festa.event', routingKey: 'event.published', payload: api, correlationId });

    return { outcome: 'created', event: api };
  });
}

export async function findEventById(id) {
  const { rows } = await pool.query(
    `SELECT *, ST_X(venue_location::geometry) AS lng, ST_Y(venue_location::geometry) AS lat
     FROM events WHERE id = $1`,
    [id],
  );
  return rows[0] ? withCounts(rows[0]) : null;
}

/**
 * Lo que ve la app: el snapshot del contrato más el conteo de asistentes (RF7). El conteo NO va en
 * event.published/updated (el esquema es estricto), solo en las respuestas HTTP.
 */
export function withCounts(row) {
  return {
    ...toApi(row),
    attendeeCount: row.attendee_count ?? 0,
    soldOut: row.capacity !== null && (row.attendee_count ?? 0) >= row.capacity,
  };
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
    `SELECT 1 FROM verified_merchants
     WHERE merchant_id = $1 AND user_id = $2 AND (revoked_at IS NULL OR verified_at > revoked_at)`,
    [merchantId, userId],
  );
  return rows.length > 0;
}

/** Nombre del comercio verificado (el que se muestra en sus eventos), o null. */
export async function verifiedMerchantName(merchantId) {
  const { rows } = await pool.query('SELECT business_name FROM verified_merchants WHERE merchant_id = $1', [merchantId]);
  return rows[0]?.business_name ?? null;
}

/** ¿Hay un comercio verificado vigente con este nombre visible? (sin distinguir mayúsculas ni espacios) */
export async function isVerifiedMerchantName(name) {
  const { rows } = await pool.query(
    `SELECT 1 FROM verified_merchants
     WHERE lower(business_name) = lower(btrim($1)) AND (revoked_at IS NULL OR verified_at > revoked_at) LIMIT 1`,
    [name],
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
  return rows.map(withCounts);
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
    // Se revalida el evento resultante con las reglas de creación (fin en el futuro; si es Parche en
    // Vivo, duración máxima y, si cambió el inicio, la ventana de 2 horas).
    const invalid = scheduleError(after, { checkLiveStart: after.startsAt !== before.startsAt });
    if (invalid) return { outcome: 'invalid_dates', error: invalid };

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
    // Cambiar el cupo puede llenar o liberar el evento: se reconcilia sold_out_at con el conteo
    // guardado en la misma transacción (y se publica event.sold_out si con el nuevo cupo queda lleno).
    if (after.capacity !== before.capacity) await reconcileSoldOut(client, id, { correlationId });
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
