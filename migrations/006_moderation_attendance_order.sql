-- Revisión del PR #9: moderación con dos restricciones independientes, suspensión persistida y
-- conteo de asistentes ordenado.

-- Un evento puede estar oculto por decisión sobre el evento (moderation.event_hidden), por la
-- suspensión de su organizador (moderation.user_suspended) o por ambas. Se guardan por separado:
-- solo vuelve a publicarse cuando no queda ninguna de las dos.
ALTER TABLE events ADD COLUMN hidden_by_moderation boolean NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN organizer_suspended boolean NOT NULL DEFAULT false;
UPDATE events SET hidden_by_moderation = true WHERE hidden_reason = 'event';
UPDATE events SET organizer_suspended = true WHERE hidden_reason = 'user_suspended';

-- Proyección local de la suspensión de cuentas: el JWT no la refleja hasta que vence, así que crear
-- eventos la consulta aquí. `decided_at` ordena las decisiones (suspender/reactivar) aunque los
-- mensajes lleguen desordenados.
CREATE TABLE suspended_users (
  user_id    uuid PRIMARY KEY,
  suspended  boolean NOT NULL,
  until      timestamptz,
  decided_at timestamptz NOT NULL
);

-- Momento (según booking) del conteo guardado en attendee_count. Un attendance.* más viejo que este
-- se ignora: no puede pisar un conteo más nuevo ni limpiar sold_out_at.
ALTER TABLE events ADD COLUMN attendee_count_at timestamptz;
