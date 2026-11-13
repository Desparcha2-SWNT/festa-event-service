import { z } from 'zod';
import { pool } from '../db/pool.js';

const CATEGORIES = ['cultural', 'musical', 'deportivo', 'gastronomico'];

const csv = (values) =>
  z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1));

/**
 * RF5 + RF6: parámetros de búsqueda del mapa. Se puede pedir por recuadro visible (bbox) o por cercanía
 * (lat, lng, radiusKm), filtrar por categoría (varias separadas por coma), rango de fechas, texto y
 * solo Parches en Vivo. Sin fechas: eventos activos y próximos (los que no han terminado).
 */
export const searchSchema = z
  .object({
    bbox: z
      .string()
      .transform((s) => s.split(',').map(Number))
      .pipe(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)]))
      .optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().positive().max(50).default(5),
    category: csv(CATEGORIES).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    q: z.string().trim().min(2).max(80).optional(),
    live: z.enum(['true', 'false']).optional(),
    free: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .refine((p) => (p.lat === undefined) === (p.lng === undefined), { message: 'lat y lng van juntos', path: ['lat'] });

/** Arma el WHERE común de búsqueda y clústeres. */
function buildFilters(p) {
  const where = [`status = 'published'`, 'ends_at > now()'];
  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (p.bbox) {
    const [minLng, minLat, maxLng, maxLat] = p.bbox;
    where.push(`venue_location && ST_MakeEnvelope(${add(minLng)}, ${add(minLat)}, ${add(maxLng)}, ${add(maxLat)}, 4326)::geography`);
  } else if (p.lat !== undefined) {
    where.push(`ST_DWithin(venue_location, ST_SetSRID(ST_MakePoint(${add(p.lng)}, ${add(p.lat)}), 4326)::geography, ${add(p.radiusKm * 1000)})`);
  }
  if (p.category) where.push(`category = ANY(${add(p.category)}::text[])`);
  if (p.from) where.push(`ends_at >= ${add(p.from)}`);
  if (p.to) where.push(`starts_at <= ${add(p.to)}`);
  if (p.live === 'true') where.push('is_live');
  if (p.free === 'true') where.push('NOT ticketed');
  if (p.q) {
    const like = add(`%${p.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`(title ILIKE ${like} OR venue_name ILIKE ${like} OR organizer_name ILIKE ${like} OR ${add(p.q.toLowerCase())} = ANY(tags))`);
  }
  return { where: where.join(' AND '), params, add };
}

/** Marcadores del mapa: lo mínimo para pintar el pin y la tarjeta (el detalle va por /events/:id). */
export async function searchEvents(p) {
  const { where, params, add } = buildFilters(p);
  const distance =
    p.lat !== undefined
      ? `, ST_Distance(venue_location, ST_SetSRID(ST_MakePoint(${add(p.lng)}, ${add(p.lat)}), 4326)::geography)::int AS distance_m`
      : '';
  const { rows } = await pool.query(
    `SELECT id, title, category, starts_at, ends_at, venue_name, organizer_name, is_live, ticketed, price_cents,
       capacity, attendee_count, featured, cover_image_url,
       ST_X(venue_location::geometry) AS lng, ST_Y(venue_location::geometry) AS lat${distance}
     FROM events WHERE ${where}
     ORDER BY featured DESC, is_live DESC, starts_at ASC
     LIMIT ${add(p.limit)}`,
    params,
  );
  return rows.map((r) => ({
    eventId: r.id,
    title: r.title,
    category: r.category,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
    // "activo" = ya empezó; "próximo" = aún no (RF5).
    happeningNow: r.starts_at <= new Date(),
    venueName: r.venue_name,
    organizerName: r.organizer_name,
    location: { lat: r.lat, lng: r.lng },
    isLive: r.is_live,
    ticketed: r.ticketed,
    priceCents: r.price_cents,
    capacity: r.capacity,
    attendeeCount: r.attendee_count,
    soldOut: r.capacity !== null && r.attendee_count >= r.capacity,
    featured: r.featured,
    coverImageUrl: r.cover_image_url,
    ...(r.distance_m !== undefined ? { distanceMeters: r.distance_m } : {}),
  }));
}

/**
 * RF5: clústeres por zona calculados en la BD (cuadrícula según el zoom), para no mandar cientos de
 * pines cuando el mapa está alejado. Con zoom alto la app pide /events directamente.
 */
export async function clusterEvents(p, zoom) {
  const { where, params, add } = buildFilters(p);
  const cell = 360 / 2 ** (zoom + 2); // tamaño de celda en grados: se reduce a la mitad por nivel de zoom
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count,
       AVG(ST_Y(venue_location::geometry)) AS lat, AVG(ST_X(venue_location::geometry)) AS lng,
       BOOL_OR(is_live) AS has_live,
       (ARRAY_AGG(id ORDER BY starts_at))[1:3] AS sample_ids
     FROM events WHERE ${where}
     GROUP BY ST_SnapToGrid(venue_location::geometry, ${add(cell)})
     ORDER BY count DESC LIMIT 500`,
    params,
  );
  return rows.map((r) => ({ count: r.count, location: { lat: r.lat, lng: r.lng }, hasLive: r.has_live, sampleEventIds: r.sample_ids }));
}
