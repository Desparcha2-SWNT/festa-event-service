import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { cancelEventSchema, createEventSchema, updateEventSchema } from './validation.js';
import {
  cancelEvent,
  createEvent,
  findEventById,
  findEventsByOrganizer,
  isMerchantOwnedAndVerified,
  updateEvent,
} from './repository.js';
import { clusterEvents, searchEvents, searchSchema } from './search.js';
import { eventExists, recordEngagement } from './lifecycle.js';

export const eventsRouter = Router();

// El gateway (Kong) ya aplica un límite por usuario (300/min, ver festa-gateway/kong.yml.tmpl).
// Este es un segundo límite, por IP, directamente en el servicio: no depende de que la
// petición pase por el gateway (defensa en profundidad).
const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
eventsRouter.use(limiter);

eventsRouter.post('/', requireAuth, async (req, res, next) => {
  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'cuerpo inválido', issues: z.treeifyError(parsed.error) });
  }
  // Un usuario normal no puede crear eventos como merchant. El claim por sí solo no basta
  // (auth-service deja autoasignarlo al registrarse): además hace falta que ESE merchantId
  // esté verificado Y sea del usuario autenticado (si no, un merchant verificado cualquiera
  // podría crear eventos a nombre de otro comercio con solo adivinar su merchantId).
  if (parsed.data.organizerType === 'merchant') {
    if (req.auth.accountType !== 'merchant') {
      return res.status(403).json({ error: 'solo un merchant puede crear eventos como merchant' });
    }
    try {
      if (!(await isMerchantOwnedAndVerified(parsed.data.merchantId, req.auth.userId))) {
        return res.status(403).json({ error: 'el comercio no está verificado o no es tuyo' });
      }
    } catch (err) {
      return next(err);
    }
  }

  try {
    const correlationId = req.headers['x-correlation-id'] ?? null;
    const event = await createEvent(parsed.data, req.auth.userId, correlationId);
    res.status(201).json(event);
  } catch (err) {
    next(err);
  }
});

// RF5 + RF6: eventos activos y próximos para el mapa y la búsqueda (bbox o cercanía, categoría,
// fechas, texto, solo Parches en Vivo, solo gratis).
eventsRouter.get('/', requireAuth, async (req, res, next) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'parámetros inválidos', issues: z.treeifyError(parsed.error) });
  try {
    res.json({ items: await searchEvents(parsed.data) });
  } catch (err) {
    next(err);
  }
});

// RF5: clústeres por zona para el mapa alejado (zoom 0–22; con zoom alto se usa GET /events).
eventsRouter.get('/clusters', requireAuth, async (req, res, next) => {
  const parsed = searchSchema.safeParse(req.query);
  const zoom = z.coerce.number().int().min(0).max(22).safeParse(req.query.zoom ?? 12);
  if (!parsed.success || !zoom.success) return res.status(400).json({ error: 'parámetros inválidos' });
  try {
    res.json({ items: await clusterEvents(parsed.data, zoom.data) });
  } catch (err) {
    next(err);
  }
});

// «Mis eventos»: los que creó el usuario autenticado. Va antes de /:id para que «mine» no se
// tome como un id.
eventsRouter.get('/mine', requireAuth, async (req, res, next) => {
  try {
    res.json({ items: await findEventsByOrganizer(req.auth.userId) });
  } catch (err) {
    next(err);
  }
});

eventsRouter.get('/:id', requireAuth, async (req, res, next) => {
  const idCheck = z.uuid().safeParse(req.params.id);
  if (!idCheck.success) return res.status(400).json({ error: 'id inválido' });

  try {
    const event = await findEventById(req.params.id);
    if (!event) return res.status(404).json({ error: 'evento no encontrado' });
    res.json(event);
  } catch (err) {
    next(err);
  }
});

const CANCEL_ERRORS = {
  not_found: [404, 'evento no encontrado'],
  forbidden: [403, 'solo quien creó el evento puede cancelarlo'],
  conflict: [409, 'el evento ya no se puede cancelar'],
};

eventsRouter.post('/:id/cancel', requireAuth, async (req, res, next) => {
  const idCheck = z.uuid().safeParse(req.params.id);
  if (!idCheck.success) return res.status(400).json({ error: 'id inválido' });

  const parsed = cancelEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'cuerpo inválido', issues: z.treeifyError(parsed.error) });
  }

  try {
    const correlationId = req.headers['x-correlation-id'] ?? null;
    const result = await cancelEvent(req.params.id, req.auth.userId, parsed.data.reason, correlationId);
    if (result.outcome !== 'cancelled') {
      const [status, error] = CANCEL_ERRORS[result.outcome];
      return res.status(status).json({ error });
    }
    res.json(result.event);
  } catch (err) {
    next(err);
  }
});

const UPDATE_ERRORS = {
  not_found: [404, 'evento no encontrado'],
  forbidden: [403, 'solo quien creó el evento puede editarlo'],
  conflict: [409, 'el evento ya no se puede editar'],
  invalid_dates: [400, 'endsAt debe ser posterior a startsAt'],
};

eventsRouter.patch('/:id', requireAuth, async (req, res, next) => {
  const idCheck = z.uuid().safeParse(req.params.id);
  if (!idCheck.success) return res.status(400).json({ error: 'id inválido' });

  const parsed = updateEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'cuerpo inválido', issues: z.treeifyError(parsed.error) });
  }

  try {
    const correlationId = req.headers['x-correlation-id'] ?? null;
    const result = await updateEvent(req.params.id, req.auth.userId, parsed.data, correlationId);
    if (result.outcome !== 'updated') {
      const [status, error] = UPDATE_ERRORS[result.outcome];
      return res.status(status).json({ error });
    }
    res.json(result.event);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- engagement (visibilidad)
const viewSchema = z
  .object({ source: z.enum(['map', 'search', 'recommendation', 'share_link', 'notification', 'profile']) })
  .strict();

// La app avisa cuándo alguien abre el detalle: el comercio ve cuántas personas vieron su evento.
eventsRouter.post('/:id/views', requireAuth, async (req, res, next) => {
  if (!z.uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'id inválido' });
  const parsed = viewSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'cuerpo inválido', issues: z.treeifyError(parsed.error) });
  try {
    if (!(await eventExists(req.params.id))) return res.status(404).json({ error: 'evento no encontrado' });
    await recordEngagement(
      'engagement.viewed',
      { eventId: req.params.id, viewerId: req.auth.userId, source: parsed.data.source, viewedAt: new Date().toISOString() },
      req.headers['x-correlation-id'] ?? null,
    );
    res.status(202).end();
  } catch (err) {
    next(err);
  }
});

// RF13: compartir con el mecanismo nativo del sistema operativo. Devuelve el enlace a compartir.
eventsRouter.post('/:id/shares', requireAuth, async (req, res, next) => {
  if (!z.uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'id inválido' });
  try {
    if (!(await eventExists(req.params.id))) return res.status(404).json({ error: 'evento no encontrado' });
    await recordEngagement(
      'engagement.shared',
      { eventId: req.params.id, sharedBy: req.auth.userId, sharedAt: new Date().toISOString() },
      req.headers['x-correlation-id'] ?? null,
    );
    res.status(201).json({ shareUrl: `${process.env.PUBLIC_SHARE_BASE_URL ?? 'https://festa.app/e'}/${req.params.id}` });
  } catch (err) {
    next(err);
  }
});
