# festa-event-service

RF4, RF5, RF6, RF19: CRUD de eventos, mapa, filtros, Parches en Vivo.

## API

Montada en `/events`; el cliente la llama como `/api/events` a través del gateway. Todas las rutas exigen JWT.

| Método y ruta | Qué hace |
|---|---|
| `POST /events` | Crea un evento (SCRUM-64). Con `organizerType: merchant` exige un comercio verificado y propio. |
| `GET /events` | RF5/RF6: eventos activos y próximos para el mapa y la búsqueda. Filtros: `bbox=minLng,minLat,maxLng,maxLat` **o** `lat`,`lng`,`radiusKm`; `category=musical,cultural`; `from`/`to`; `q` (título, lugar, organizador, etiqueta); `live=true` (solo Parches en Vivo); `free=true`; `limit` (≤ 500). Incluye `attendeeCount`, `soldOut`, `happeningNow` y `distanceMeters` |
| `GET /events/clusters?zoom=12&…` | RF5: clústeres por zona (mismos filtros) para el mapa alejado |
| `POST /events/:id/views` `{source}` | Registra que alguien abrió el detalle (`engagement.viewed`), para el panel del comercio |
| `POST /events/:id/shares` | RF13: registra el compartido (`engagement.shared`) y devuelve `shareUrl` (`PUBLIC_SHARE_BASE_URL`) |
| `GET /events/mine` | Eventos creados por el usuario autenticado, en todos los estados, del más reciente al más antiguo. |
| `GET /events/:id` | Un evento por id. |
| `PATCH /events/:id` | Edita un evento (SCRUM-67). Solo se envían los campos que cambian: `title`, `description`, `descriptionAiGenerated`, `category`, `startsAt`, `endsAt`, `venue`, `capacity`. Publica `event.updated` y, si cambia la hora de inicio o el lugar, también `event.rescheduled` para avisar a los asistentes. |
| `POST /events/:id/cancel` | Cancela un evento (SCRUM-68) y publica `event.cancelled`. |

Editar y cancelar siguen la misma regla (SCRUM-69): solo el creador (403 para los demás) y solo un evento
publicado que no ha terminado (409 si no). El tipo de organizador, el comercio, la boletería y el precio no se
editan, porque de ellos dependen pagos y pases ya emitidos.

### Parches en Vivo (RF19)

`POST /events` con `isLive: true` exige que empiece en menos de 2 horas (se toleran 15 min en el pasado) y que dure
máximo 8 horas. Un job cada minuto expira todo evento que terminó (`status = expired`, `event.expired`), así los
parches desaparecen solos del mapa; booking cierra el check-in y payment la venta.

### Lo que consume

| Mensaje | Efecto |
|---|---|
| `attendance.confirmed` / `attendance.cancelled` | `attendeeCount` vigente; si se llena el cupo publica `event.sold_out` (una vez) |
| `moderation.event_hidden` / `event_restored` | Oculta o vuelve a mostrar el evento (`event.updated`) |
| `moderation.user_suspended` / `user_reinstated` | Oculta los eventos vigentes del organizador y al reactivarlo devuelve solo esos |
| `merchant.verified` / `merchant.updated` | Comercios verificados; el nuevo nombre se refleja en sus eventos vigentes |
| `account.deleted` | Cancela sus eventos futuros y anonimiza el organizador (Ley 1581) |

## Arranque local

Necesita la infraestructura de `festa-infra` corriendo (Postgres+PostGIS, RabbitMQ) — ver su
README. Clona este repo como hermano de `festa-infra` y `festa-auth-service`.

```bash
cp .env.example .env              # edita DATABASE_URL/AMQP_URL si no usas docker compose
npm install
npm run migrate                   # crea las tablas (events, outbox, processed_events)
npm start
```

También se puede levantar con el resto del stack: `docker compose --profile event up -d --build`
desde `festa-infra`.

## Arquitectura

- **API**: Express, montado en `/events` (no `/api/events`) — el cliente le pega a
  `/api/events`, pero un plugin global de Kong quita el `/api` antes de reenviar al upstream
  (ver `festa-gateway/kong.yml.tmpl`, mismo patrón que `/api/auth` → `/auth`). El gateway ya
  valida el JWT antes de que la petición llegue aquí; `src/middleware/auth.js` solo lo
  decodifica para saber quién es el usuario.
- **Datos**: Postgres con PostGIS. Las coordenadas del lugar del evento van en una columna
  `geography(Point, 4326)` (`migrations/001_events.sql`), para poder consultar cercanía más
  adelante (RF5) sin tabla aparte.
- **Mensajería**: outbox transaccional al publicar (`event.published` al crear) e inbox con
  idempotencia al consumir, siguiendo exactamente lo que define
  [`festa-infra/contracts/README.md`](../festa-infra/contracts/README.md). El worker de outbox
  y el consumidor de inbox corren dentro del mismo proceso (`src/server.js`), no como un job
  aparte — alcanza para el volumen del pilot. El inbox valida el sobre y `data` de cada mensaje
  contra los esquemas reales (`src/messaging/schemaRegistry.js`) antes de despachar a un
  handler; lo inválido va directo a la DLQ, no se reintenta. Hoy tiene handler para
  `merchant.verified` (proyección de comercios verificados, `verified_merchants`) y
  `account.deleted` (cancela los eventos futuros del organizador y anonimiza su nombre en
  todos, pasados y futuros — Ley 1581).
- **Autorización de "merchant"**: el claim `role: merchant` del JWT solo dice que la cuenta se
  registró como comercio (auth-service lo deja autoasignar al registrarse), no que esté
  verificado ni que un `merchantId` dado sea suyo. Crear un evento `ticketed` exige además que
  ese `merchantId` esté en `verified_merchants` **con ese mismo `user_id`**.
- **Resiliencia**: si RabbitMQ se cae después de que el servicio ya arrancó (no solo al
  arrancar), `src/messaging/supervisor.js` reconecta y vuelve a armar el publicador y el
  consumidor solo. Las migraciones piden un advisory lock de Postgres
  (`src/db/migrate.js`) para que dos réplicas arrancando a la vez no corran la misma dos veces.
- **Detrás de Kong**: Express confía en un proxy (`TRUST_PROXY`, por defecto 1), así que `req.ip`
  es la IP del cliente que Kong pone en `X-Forwarded-For`, no la de Kong. Sin eso, el límite por IP
  de `src/events/routes.js` lo compartirían todos los clientes.

## Pruebas

```bash
npm test
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/event_it npm test   # + integración con PostGIS
```

La prueba de contrato (`test/contract.test.js`) valida que lo que arma este servicio para
`event.published` cumpla el esquema real de `festa-infra/contracts`. Si no encuentra ese repo
como hermano, se salta sola (y lo avisa) — en CI y en el build de Docker sí se exige, con
`FESTA_CONTRACTS_DIR` apuntando a los contratos.

## Despliegue (CD)

`.github/workflows/cd.yml` construye la imagen con los contratos de `festa-infra` como
build-context (las pruebas corren dentro del build) y, en un push a `main`, la publica en
`ghcr.io/desparcha2-swnt/festa-event-service` con los tags `sha-<commit>` y `latest`. En un PR
solo la construye. El paso de desplegar en AWS llega con SCRUM-134.
