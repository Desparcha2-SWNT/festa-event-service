-- RF5/RF6 (mapa y búsqueda), RF7 (conteo de asistentes), RF14 (moderación), RF19 (Parches en Vivo).

-- Conteo vigente de asistentes: lo manda booking-service en attendance.confirmed / attendance.cancelled.
ALTER TABLE events ADD COLUMN attendee_count integer NOT NULL DEFAULT 0 CHECK (attendee_count >= 0);
-- Cuándo se agotó el cupo (se publica event.sold_out una sola vez por cada vez que se llena).
ALTER TABLE events ADD COLUMN sold_out_at timestamptz;
-- Por qué está oculto: un admin ocultó el evento, o se suspendió la cuenta del organizador. Al
-- reactivar la cuenta solo vuelven los que se ocultaron por la suspensión.
ALTER TABLE events ADD COLUMN hidden_reason text CHECK (hidden_reason IN ('event', 'user_suspended'));

-- Mapa y búsqueda solo miran eventos publicados que no han terminado (RNF1: < 2 s).
CREATE INDEX events_active_ends_at_idx ON events (ends_at) WHERE status = 'published';
CREATE INDEX events_active_category_idx ON events (category, starts_at) WHERE status = 'published';
CREATE INDEX events_merchant_id_idx ON events (merchant_id);
