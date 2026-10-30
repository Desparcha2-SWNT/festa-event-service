# syntax=docker/dockerfile:1.7
# Build:  docker build --build-context contracts=../festa-infra/contracts -t festa-event-service .
# (docker compose en festa-infra ya pasa el contexto "contracts").

FROM node:20-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
COPY --from=contracts . /contracts
# Las pruebas (incluida la de contrato) corren en el build: si fallan, no hay imagen.
RUN FESTA_CONTRACTS_DIR=/contracts npm test
RUN npm prune --omit=dev

FROM node:20-alpine
RUN addgroup -S festa && adduser -S festa -G festa
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/package.json ./
COPY --from=build /build/src ./src
COPY --from=build /build/migrations ./migrations
# El inbox valida mensajes contra estos esquemas en runtime (src/messaging/schemaRegistry.js),
# no solo en las pruebas: también hacen falta en la imagen final, no solo en el build.
COPY --from=build /contracts ./contracts
ENV FESTA_CONTRACTS_DIR=/app/contracts
USER festa
EXPOSE 8083
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://localhost:8083/health > /dev/null || exit 1
ENTRYPOINT ["node", "src/server.js"]
