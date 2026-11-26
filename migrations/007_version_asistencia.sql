-- Versión monotónica del conteo de asistentes (booking-service: attendanceVersion).
-- Solo se aplica un conteo con versión mayor que la guardada; la hora ya no decide el orden.
ALTER TABLE events ADD COLUMN attendee_count_version bigint NOT NULL DEFAULT 0;
