-- 002_locations.sql
-- Точки на карте, где живёт или измеряется пользователь.
-- Rollback: DROP TABLE locations;

CREATE TABLE locations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    key         text NOT NULL,
    name        text NOT NULL,
    country     text NOT NULL,

    lat         numeric(9,6) NOT NULL,
    lon         numeric(9,6) NOT NULL,
    timezone    text NOT NULL,

    is_primary  boolean NOT NULL DEFAULT false,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, key)
);

COMMENT ON TABLE  locations             IS 'Точки, где живёт или измеряется пользователь. Москва, Говардхан и т.д.';
COMMENT ON COLUMN locations.key         IS 'Стабильный ключ для ссылок из кода: moscow, govardhan.';
COMMENT ON COLUMN locations.timezone    IS 'IANA-имя зоны: Europe/Moscow, Asia/Kolkata. Никаких +03:00 строк.';
COMMENT ON COLUMN locations.is_primary  IS 'Основная локация (где провёл больше всего времени). Информационное поле.';

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON locations
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE TRIGGER trigger_update_updated_at
    BEFORE UPDATE ON locations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_locations_user ON locations(user_id);
