# festa-event-service

RF4, RF5, RF6, RF19: CRUD de eventos, mapa, filtros, Parches en Vivo.

Hoy (SCRUM-64) tiene el esqueleto del servicio y lo mínimo de RF4: crear un evento y leerlo
por id. El resto (editar/cancelar, búsqueda, mapa, clústeres, Parches en Vivo) son historias
aparte — ver el catálogo completo en Jira bajo [SCRUM-7 "Gestión de eventos"](https://desparcha2.atlassian.net/browse/SCRUM-7)
y [SCRUM-8 "Mapa y descubrimiento"](https://desparcha2.atlassian.net/browse/SCRUM-8).

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

- **API**: Express. El gateway (Kong) ya valida el JWT antes de que la petición llegue aquí;
  `src/middleware/auth.js` solo lo decodifica para saber quién es el usuario.
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

## Pruebas

```bash
npm test
```

La prueba de contrato (`test/contract.test.js`) valida que lo que arma este servicio para
`event.published` cumpla el esquema real de `festa-infra/contracts`. Si no encuentra ese repo
como hermano, se salta sola (y lo avisa) — en CI y en el build de Docker sí se exige, con
`FESTA_CONTRACTS_DIR` apuntando a los contratos.
