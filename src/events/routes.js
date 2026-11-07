import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { createEventSchema } from './validation.js';
import { createEvent, findEventById, isMerchantOwnedAndVerified } from './repository.js';

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
