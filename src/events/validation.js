import { z } from 'zod';

const LIVE_WINDOW_MS = 2 * 3600_000;
const LIVE_MAX_DURATION_MS = 8 * 3600_000;
// Se tolera un inicio unos minutos en el pasado (lo que tarda en llenarse el formulario).
const LIVE_PAST_TOLERANCE_MS = 15 * 60_000;

export function isWithinLiveWindow(startsAt, now = Date.now()) {
  const t = new Date(startsAt).getTime();
  return t >= now - LIVE_PAST_TOLERANCE_MS && t <= now + LIVE_WINDOW_MS;
}

const categorySchema = z.enum(['cultural', 'musical', 'deportivo', 'gastronomico']);

const venueSchema = z.object({
  name: z.string().max(120),
  address: z.string().max(200),
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
});

// Espejo del `data` de contracts/events/event/event.published.schema.json, para lo que
// recibe este endpoint (el resto de ese esquema lo completa el servicio: eventId, status, version...).
export const createEventSchema = z
  .object({
    organizerType: z.enum(['user', 'merchant']),
    merchantId: z.uuid().optional(),
    organizerName: z.string().max(120),
    title: z.string().min(3).max(120),
    description: z.string().max(2000),
    descriptionAiGenerated: z.boolean().optional().default(false),
    category: categorySchema,
    tags: z.array(z.string().max(30)).max(10).optional().default([]),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    venue: venueSchema,
    capacity: z.number().int().min(1).nullable().optional(),
    ticketed: z.boolean().optional().default(false),
    priceCents: z.number().int().min(0).optional().default(0),
    maxTicketsPerOrder: z.number().int().min(1).max(10).optional(),
    coverImageUrl: z.url().nullable().optional(),
    // RF19: Parche en Vivo, plan improvisado que arranca en menos de 2 horas y expira solo al terminar.
    isLive: z.boolean().optional().default(false),
  })
  .refine((e) => new Date(e.endsAt) > new Date(e.startsAt), {
    message: 'endsAt debe ser posterior a startsAt',
    path: ['endsAt'],
  })
  .refine((e) => !e.ticketed || e.organizerType === 'merchant', {
    message: 'solo un merchant verificado puede vender boletas (ticketed)',
    path: ['ticketed'],
  })
  .refine((e) => e.organizerType !== 'merchant' || e.merchantId, {
    // El contrato (event.published.schema.json) dice "Presente si organizerType = merchant".
    message: 'merchantId es obligatorio cuando organizerType es merchant',
    path: ['merchantId'],
  })
  .refine((e) => !e.isLive || isWithinLiveWindow(e.startsAt), {
    message: 'un Parche en Vivo debe empezar en menos de 2 horas',
    path: ['startsAt'],
  })
  .refine((e) => !e.isLive || new Date(e.endsAt) - new Date(e.startsAt) <= LIVE_MAX_DURATION_MS, {
    message: 'un Parche en Vivo dura máximo 8 horas',
    path: ['endsAt'],
  })
  .refine((e) => e.isLive || new Date(e.endsAt) > new Date(), {
    message: 'el evento ya terminó',
    path: ['endsAt'],
  })
  .refine((e) => e.ticketed || e.priceCents === 0, {
    message: 'priceCents debe ser 0 si el evento no es ticketed',
    path: ['priceCents'],
  });

// El motivo viaja en event.cancelled (máximo 500 caracteres, ver event.cancelled.schema.json).
export const cancelEventSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

// SCRUM-67: lo que el organizador puede cambiar de un evento publicado (Figma «25 · Editar evento»).
// Solo se envían los campos que cambian. El tipo de organizador, el comercio, la boletería y el
// precio no se editan: de ellos dependen pagos y pases ya emitidos. Que endsAt quede después de
// startsAt se valida al combinar con el evento guardado (ver updateEvent), porque puede llegar
// solo uno de los dos.
export const updateEventSchema = z
  .object({
    title: z.string().min(3).max(120),
    description: z.string().max(2000),
    descriptionAiGenerated: z.boolean(),
    category: categorySchema,
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    venue: venueSchema,
    capacity: z.number().int().min(1).nullable(),
  })
  .partial()
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, { message: 'no hay cambios' });
