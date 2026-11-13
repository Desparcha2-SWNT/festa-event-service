import { pool, withTransaction } from '../db/pool.js';
import { enqueue } from '../messaging/outboxRepository.js';
import { toApi } from './repository.js';

const RETURNING = 'RETURNING *, ST_X(venue_location::geometry) AS lng, ST_Y(venue_location::geometry) AS lat';

/**
 * Expira los eventos que ya terminaron (incluye los Parches en Vivo, RF19): salen del mapa y se
 * publica event.expired para que booking cierre el check-in y payment cierre la venta.
 * SKIP LOCKED permite varias réplicas.
 */
export async function expireFinishedEvents(limit = 200) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM events WHERE status IN ('published', 'hidden') AND ends_at <= now()
       ORDER BY ends_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const { id } of rows) {
      const updated = await client.query(
        `UPDATE events SET status = 'expired', version = version + 1, updated_at = now() WHERE id = $1 RETURNING id, is_live, updated_at`,
        [id],
      );
      const row = updated.rows[0];
      await enqueue(client, {
        exchange: 'festa.event',
        routingKey: 'event.expired',
        payload: { eventId: row.id, expiredAt: row.updated_at.toISOString(), isLive: row.is_live },
      });
    }
    return rows.length;
  });
}

/**
 * RF7: booking-service manda el conteo vigente en cada attendance.*. Si con él se llena el cupo, se
 * publica event.sold_out (una vez cada vez que se llena; si se libera un cupo, se puede volver a llenar).
 */
export async function applyAttendeeCount(client, eventId, attendeeCount, causationId) {
  const { rows } = await client.query('SELECT capacity, sold_out_at FROM events WHERE id = $1 FOR UPDATE', [eventId]);
  const event = rows[0];
  if (!event) return;
  const full = event.capacity !== null && attendeeCount >= event.capacity;
  const { rows: updated } = await client.query(
    `UPDATE events SET attendee_count = $2,
       sold_out_at = CASE WHEN $3 THEN COALESCE(sold_out_at, now()) ELSE NULL END
     WHERE id = $1 RETURNING sold_out_at`,
    [eventId, attendeeCount, full],
  );
  if (full && !event.sold_out_at) {
    await enqueue(client, {
      exchange: 'festa.event',
      routingKey: 'event.sold_out',
      payload: { eventId, capacity: event.capacity, soldOutAt: updated[0].sold_out_at.toISOString() },
      causationId,
    });
  }
}

/** Cambia el estado (moderación) y publica event.updated con el snapshot completo. */
async function setStatus(client, whereSql, params, set, causationId) {
  const { rows } = await client.query(`UPDATE events SET ${set}, version = version + 1, updated_at = now() WHERE ${whereSql} ${RETURNING}`, params);
  for (const row of rows) {
    await enqueue(client, { exchange: 'festa.event', routingKey: 'event.updated', payload: toApi(row), causationId });
  }
  return rows.length;
}

export const moderation = {
  hideEvent: (client, eventId, causationId) =>
    setStatus(client, `id = $1 AND status = 'published'`, [eventId], `status = 'hidden', hidden_reason = 'event'`, causationId),
  restoreEvent: (client, eventId, causationId) =>
    setStatus(client, `id = $1 AND status = 'hidden' AND ends_at > now()`, [eventId], `status = 'published', hidden_reason = NULL`, causationId),
  hideUserEvents: (client, userId, causationId) =>
    setStatus(client, `organizer_id = $1 AND status = 'published' AND ends_at > now()`, [userId], `status = 'hidden', hidden_reason = 'user_suspended'`, causationId),
  restoreUserEvents: (client, userId, causationId) =>
    setStatus(
      client,
      `organizer_id = $1 AND status = 'hidden' AND hidden_reason = 'user_suspended' AND ends_at > now()`,
      [userId],
      `status = 'published', hidden_reason = NULL`,
      causationId,
    ),
};

/** merchant.updated: el nombre visible del comercio se actualiza en sus eventos vigentes. */
export async function renameMerchant(client, data, causationId) {
  await client.query('UPDATE verified_merchants SET business_name = $2 WHERE merchant_id = $1', [data.merchantId, data.businessName]);
  return setStatus(
    client,
    `merchant_id = $1 AND organizer_name <> $2 AND status IN ('published', 'hidden') AND ends_at > now()`,
    [data.merchantId, data.businessName],
    'organizer_name = $2',
    causationId,
  );
}

/** Engagement (visibilidad para el comercio). Se encola fuera de una transacción de negocio. */
export async function recordEngagement(routingKey, payload, correlationId) {
  return withTransaction((client) => enqueue(client, { exchange: 'festa.event', routingKey, payload, correlationId }));
}

export async function eventExists(id) {
  const { rows } = await pool.query(`SELECT 1 FROM events WHERE id = $1 AND status IN ('published', 'expired')`, [id]);
  return rows.length > 0;
}
