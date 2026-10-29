import { z } from 'zod';

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
    category: z.enum(['cultural', 'musical', 'deportivo', 'gastronomico']),
    tags: z.array(z.string().max(30)).max(10).optional().default([]),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    venue: z.object({
      name: z.string().max(120),
      address: z.string().max(200),
      location: z.object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      }),
    }),
    capacity: z.number().int().min(1).nullable().optional(),
    ticketed: z.boolean().optional().default(false),
    priceCents: z.number().int().min(0).optional().default(0),
    maxTicketsPerOrder: z.number().int().min(1).max(10).optional(),
    coverImageUrl: z.url().nullable().optional(),
  })
  .refine((e) => new Date(e.endsAt) > new Date(e.startsAt), {
    message: 'endsAt debe ser posterior a startsAt',
    path: ['endsAt'],
  })
  .refine((e) => !e.ticketed || e.organizerType === 'merchant', {
    message: 'solo un merchant verificado puede vender boletas (ticketed)',
    path: ['ticketed'],
  })
  .refine((e) => e.ticketed || e.priceCents === 0, {
    message: 'priceCents debe ser 0 si el evento no es ticketed',
    path: ['priceCents'],
  });
