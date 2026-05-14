-- 007_weather_log.sql
-- Лог температуры по локации. Заполняется Edge Function 'weather' лениво
-- (фронт спрашивает — функция проверяет кэш, при необходимости тянет Open-Meteo).
-- Rollback: DROP TABLE weather_log;

CREATE TABLE weather_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

    measured_at     timestamptz NOT NULL,
    temperature_c   numeric(5,2) NOT NULL,
    feels_like_c    numeric(5,2),

    source          text NOT NULL DEFAULT 'open-meteo',
    raw_response    jsonb NOT NULL,

    created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  weather_log              IS 'Замеры температуры по локации. Лениво наполняется при открытии утреннего экрана.';
COMMENT ON COLUMN weather_log.measured_at  IS 'Время замера у Open-Meteo (округлено до 15 мин по их апи).';
COMMENT ON COLUMN weather_log.source       IS 'Поставщик: open-meteo. Может в будущем разойтись на openweather/met.no.';

ALTER TABLE weather_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON weather_log
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE INDEX idx_weather_log_user_loc_time ON weather_log(user_id, location_id, measured_at DESC);
