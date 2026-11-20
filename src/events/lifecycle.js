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
 * Recalcula sold_out_at con el cupo y el conteo guardados (la fila ya está bloqueada por quien
 * llama). Publica event.sold_out solo en la transición a lleno; si se libera cupo, lo limpia para
 * que el siguiente llenado vuelva a avisar. Lo usan el conteo de booking y el cambio de cupo (PATCH).
 */
export async function reconcileSoldOut(client, eventId, { causationId, correlationId } = {}) {
  const { rows } = await client.query(
    `WITH prev AS (SELECT sold_out_at FROM events WHERE id = $1)
     UPDATE events SET sold_out_at = CASE WHEN capacity IS NOT NULL AND attendee_count >= capacity
                                          THEN COALESCE(sold_out_at, now()) ELSE NULL END
     WHERE id = $1
     RETURNING capacity, sold_out_at, (SELECT sold_out_at FROM prev) AS prev_sold_out_at`,
    [eventId],
  );
  const row = rows[0];
  if (row?.sold_out_at && !row.prev_sold_out_at) {
    await enqueue(client, {
      exchange: 'festa.event',
      routingKey: 'event.sold_out',
      payload: { eventId, capacity: row.capacity, soldOutAt: row.sold_out_at.toISOString() },
      causationId,
      correlationId,
    });
  }
}

/**
 * RF7: booking-service manda el conteo vigente en cada attendance.* con `attendanceVersion`, una versión
 * monotónica por evento que booking sube en cada cambio. Los mensajes pueden llegar desordenados o
 * reintentarse tarde: solo se aplica una versión mayor que la guardada, así un conteo viejo no pisa uno
 * más nuevo ni limpia sold_out_at. La hora (countedAt) ya no decide el orden: dos cambios en el mismo
 * milisegundo se distinguen por la versión.
 */
export async function applyAttendeeCount(client, eventId, attendeeCount, countedAt, causationId, attendanceVersion) {
  const { rows } = await client.query('SELECT attendee_count_version FROM events WHERE id = $1 FOR UPDATE', [eventId]);
  const event = rows[0];
  if (!event) return;
  if (attendanceVersion <= Number(event.attendee_count_version)) return;
  await client.query(
    'UPDATE events SET attendee_count = $2, attendee_count_at = $3, attendee_count_version = $4 WHERE id = $1',
    [eventId, attendeeCount, countedAt, attendanceVersion],
  );
  await reconcileSoldOut(client, eventId, { causationId });
}

/**
 * Serializa, por organizador, crear eventos y suspender/reactivar su cuenta: sin esto, un POST
 * /events que leyó «no suspendido» podría confirmar después de que la suspensión ocultó sus eventos.
 */
export async function lockOrganizer(client, userId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId]);
}

/** ¿La cuenta está suspendida según la última decisión de moderación recibida? */
export async function isSuspended(client, userId) {
  const { rows } = await client.query(
    'SELECT 1 FROM suspended_users WHERE user_id = $1 AND suspended AND (until IS NULL OR until > now())',
    [userId],
  );
  return rows.length > 0;
}

/**
 * Lleva `status` al que dicen las dos restricciones (oculto por el evento u oculto por la suspensión)
 * y publica event.updated solo para los eventos que cambiaron. Un evento que ya terminó no se vuelve
 * a publicar (el job lo expira).
 */
async function syncVisibility(client, whereSql, params, causationId) {
  const target = `CASE WHEN hidden_by_moderation OR organizer_suspended THEN 'hidden' ELSE 'published' END`;
  const { rows } = await client.query(
    `UPDATE events SET status = ${target}, version = version + 1, updated_at = now()
     WHERE ${whereSql} AND status IN ('published', 'hidden') AND status <> ${target}
       AND (${target} = 'hidden' OR ends_at > now())
     ${RETURNING}`,
    params,
  );
  for (const row of rows) {
    await enqueue(client, { exchange: 'festa.event', routingKey: 'event.updated', payload: toApi(row), causationId });
  }
  return rows.length;
}

const HIDDEN_REASON = `hidden_reason = CASE WHEN hidden_by_moderation THEN 'event' WHEN organizer_suspended THEN 'user_suspended' END`;

async function setFlag(client, whereSql, params, set, causationId) {
  await client.query(`UPDATE events SET ${set} WHERE ${whereSql} AND status IN ('published', 'hidden')`, params);
  await client.query(`UPDATE events SET ${HIDDEN_REASON} WHERE ${whereSql} AND status IN ('published', 'hidden')`, params);
  return syncVisibility(client, whereSql, params, causationId);
}

/**
 * Guarda la decisión de suspender/reactivar si es más nueva que la guardada (por decidedAt).
 * Devuelve false si el mensaje es viejo y no hay que tocar los eventos.
 */
async function recordSuspension(client, data, suspended) {
  await lockOrganizer(client, data.userId);
  const { rows } = await client.query(
    `INSERT INTO suspended_users (user_id, suspended, until, decided_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET suspended = EXCLUDED.suspended, until = EXCLUDED.until, decided_at = EXCLUDED.decided_at
       WHERE suspended_users.decided_at <= EXCLUDED.decided_at
     RETURNING user_id`,
    [data.userId, suspended, suspended ? (data.until ?? null) : null, data.decidedAt],
  );
  return rows.length > 0;
}

/**
 * RF14. La decisión sobre un evento y la suspensión del organizador son independientes: ocultar un
 * evento que ya estaba oculto por la suspensión deja la marca del evento, y reactivar la cuenta no lo
 * devuelve; restaurar un evento no lo publica mientras su organizador siga suspendido.
 */
export const moderation = {
  hideEvent: (client, eventId, causationId) =>
    setFlag(client, 'id = $1', [eventId], 'hidden_by_moderation = true', causationId),
  restoreEvent: (client, eventId, causationId) =>
    setFlag(client, 'id = $1', [eventId], 'hidden_by_moderation = false', causationId),
  hideUserEvents: async (client, data, causationId) =>
    (await recordSuspension(client, data, true))
      ? setFlag(client, 'organizer_id = $1', [data.userId], 'organizer_suspended = true', causationId)
      : 0,
  restoreUserEvents: async (client, data, causationId) =>
    (await recordSuspension(client, data, false))
      ? setFlag(client, 'organizer_id = $1', [data.userId], 'organizer_suspended = false', causationId)
      : 0,
};

/** Aplica `set` a los eventos que cumplen `whereSql` y publica event.updated con cada snapshot. */
async function setStatus(client, whereSql, params, set, causationId) {
  const { rows } = await client.query(`UPDATE events SET ${set}, version = version + 1, updated_at = now() WHERE ${whereSql} ${RETURNING}`, params);
  for (const row of rows) {
    await enqueue(client, { exchange: 'festa.event', routingKey: 'event.updated', payload: toApi(row), causationId });
  }
  return rows.length;
}

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
