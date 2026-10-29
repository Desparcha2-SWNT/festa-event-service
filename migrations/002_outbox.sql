-- Outbox transaccional (ver festa-infra/contracts/README.md § Publicar).
-- El cambio de estado del evento y la fila de outbox se guardan en la misma transacción,
-- así nunca hay un cambio guardado sin su evento de dominio correspondiente.

CREATE TABLE outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange     text NOT NULL,
  routing_key  text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);

-- El worker publicador solo lee las pendientes (sent_at IS NULL), en orden de creación.
CREATE INDEX outbox_pending_idx ON outbox (created_at) WHERE sent_at IS NULL;
