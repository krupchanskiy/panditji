-- 016_vaishnava_panchanga.sql
-- Панчанга и астрономика на каждый день для (user_id, location_id).
-- Источник — gaurabda, считается тем же ежемесячным GHA-cron'ом.
-- Отдельная таблица от vaishnava_calendar: там per-event, тут per-day.
-- Rollback: DROP TABLE vaishnava_panchanga;

CREATE TABLE vaishnava_panchanga (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

    date            date NOT NULL,

    -- Лунный календарь
    tithi_index     int  NOT NULL,
    tithi_name      text NOT NULL,
    paksha          text NOT NULL,        -- 'Шукла' | 'Кришна'
    masa_name       text NOT NULL,
    gaurabda_year   int  NOT NULL,
    naksatra_name   text,

    -- Солнце (timestamptz с указанием локального tz)
    brahma_muhurta_at timestamptz,
    sunrise_at      timestamptz,
    noon_at         timestamptz,
    sunset_at       timestamptz,
    day_length_min  int,

    -- Луна
    moonrise_at     timestamptz,
    moonset_at      timestamptz,
    moon_age_days   numeric(4,2),
    moon_illumination numeric(5,2),       -- 0–100 %

    -- Метаданные
    calculated_by      text NOT NULL,
    calculator_version text,
    calculated_at      timestamptz NOT NULL DEFAULT now(),

    UNIQUE(user_id, location_id, date)
);

COMMENT ON TABLE  vaishnava_panchanga         IS 'Панчанга (титхи/маса/пакша/гаурабда) + астро (солнце/луна) на каждый день. Per-day per-location.';
COMMENT ON COLUMN vaishnava_panchanga.tithi_index IS '1-30, где 1-15 в шукла-пакше, 16-30 в кришна-пакше (30 = амавасья).';
COMMENT ON COLUMN vaishnava_panchanga.tithi_name IS 'Русское название титхи: Пратипат, Двитья, ... Двадаши, Трайодаши, Чатурдаши, Пурнима/Амавасья.';
COMMENT ON COLUMN vaishnava_panchanga.masa_name IS 'Русское название масы: Вишну, Мадхусудана, Тривикрама, ... плюс «адхика» для високосного.';

ALTER TABLE vaishnava_panchanga ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON vaishnava_panchanga
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE INDEX idx_panchanga_lookup
    ON vaishnava_panchanga(user_id, location_id, date);
