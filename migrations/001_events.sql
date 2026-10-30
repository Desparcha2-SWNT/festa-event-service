-- Modelo de datos de eventos. Las coordenadas van en una columna `geography(Point, 4326)`
-- de PostGIS para poder hacer consultas de cercanía (RF5, SCRUM-74) sin tabla aparte.

CREATE TABLE events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id             uuid NOT NULL,
  organizer_type           text NOT NULL CHECK (organizer_type IN ('user', 'merchant')),
  merchant_id              uuid,
  organizer_name           text NOT NULL,
  title                    text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description              text NOT NULL CHECK (char_length(description) <= 2000),
  description_ai_generated boolean NOT NULL DEFAULT false,
  category                 text NOT NULL CHECK (category IN ('cultural', 'musical', 'deportivo', 'gastronomico')),
  tags                     text[] NOT NULL DEFAULT '{}',
  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz NOT NULL,
  venue_name               text NOT NULL,
  venue_address            text NOT NULL,
  venue_location           geography(Point, 4326) NOT NULL,
  capacity                 integer CHECK (capacity IS NULL OR capacity >= 1),
  ticketed                 boolean NOT NULL DEFAULT false,
  price_cents              integer NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  max_tickets_per_order    integer CHECK (max_tickets_per_order IS NULL OR max_tickets_per_order BETWEEN 1 AND 10),
  currency                 text NOT NULL DEFAULT 'COP' CHECK (currency = 'COP'),
  featured                 boolean NOT NULL DEFAULT false,
  is_live                  boolean NOT NULL DEFAULT false,
  cover_image_url          text,
  status                   text NOT NULL DEFAULT 'published'
                             CHECK (status IN ('published', 'hidden', 'cancelled', 'expired')),
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (ticketed OR price_cents = 0),
  CHECK (NOT ticketed OR organizer_type = 'merchant')
);

-- El mapa (RF5) y la búsqueda cercana (SCRUM-74) filtran por ubicación y por estado+fecha.
CREATE INDEX events_venue_location_idx ON events USING gist (venue_location);
CREATE INDEX events_status_starts_at_idx ON events (status, starts_at);
CREATE INDEX events_organizer_id_idx ON events (organizer_id);
