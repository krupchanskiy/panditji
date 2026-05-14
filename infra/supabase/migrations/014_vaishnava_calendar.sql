-- 014_vaishnava_calendar.sql
-- Вайшнавский календарь: экадаши, паран-окна, появления/уходы, пурнима/амавасья.
-- Считается отдельно для каждой локации (восход → паран привязаны к точке).
-- Источник расчёта: GitHub Actions cron + gaurabda (Python). Запись через REST API service_role.
--
-- Решение по paran_type: храним как text без CHECK на этом этапе — посмотрим, что реально
-- выдаст gaurabda на первом прогоне, и нормализуем позже. Дополнительно paran_note для
-- человеческого пояснения (например, «до восхода Хаста-накшатры»).
--
-- astro_naming_map намеренно НЕ создаём — добавим после первого smoke-test, когда увидим,
-- какие строки приходят из gaurabda. Возможно, библиотека сразу даёт ISKCON-кириллицу.
--
-- Rollback: DROP TABLE vaishnava_calendar;

CREATE TABLE vaishnava_calendar (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    location_id     uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

    event_date      date NOT NULL,
    event_type      text NOT NULL,
    event_name      text NOT NULL,

    -- Поля экадаши (NULL для всех остальных event_type)
    ekadashi_type   text,
    fasting_start_at timestamptz,
    fasting_end_at  timestamptz,
    paran_start_at  timestamptz,
    paran_end_at    timestamptz,
    paran_type      text,
    paran_note      text,

    description     text,

    calculated_by      text NOT NULL,
    calculator_version text,
    calculated_at      timestamptz NOT NULL DEFAULT now(),

    UNIQUE(user_id, location_id, event_date, event_name)
);

COMMENT ON TABLE  vaishnava_calendar                IS 'Вайшнавский календарь: экадаши, паран, появления/уходы. По одной строке на (локация, дата, событие).';
COMMENT ON COLUMN vaishnava_calendar.event_type     IS 'ekadashi | appearance | disappearance | purnima | amavasya | caturmasya_start | caturmasya_end | other';
COMMENT ON COLUMN vaishnava_calendar.event_name     IS 'Имя события на русском ISKCON-стандарт: «Падмини Экадаши», «Гаура-пурнима», «Прабхупада тиробхава».';
COMMENT ON COLUMN vaishnava_calendar.ekadashi_type  IS 'regular | mahadvadashi. NULL для не-экадаши.';
COMMENT ON COLUMN vaishnava_calendar.paran_type     IS 'Тип окна выхода из поста: first_quarter | dvadashi_end | dvadashi_short | sandhi (что именно — увидим после первого прогона gaurabda).';
COMMENT ON COLUMN vaishnava_calendar.paran_note     IS 'Человеческое пояснение паран-окна, если есть («до восхода Хаста-накшатры»).';
COMMENT ON COLUMN vaishnava_calendar.calculated_by  IS 'Идентификатор источника: gaurabda-0.8.4, swisseph-v1 и т.п.';

ALTER TABLE vaishnava_calendar ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON vaishnava_calendar
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE INDEX idx_vaishnava_calendar_lookup
    ON vaishnava_calendar(user_id, location_id, event_date);

CREATE INDEX idx_vaishnava_calendar_ekadashi
    ON vaishnava_calendar(user_id, location_id, event_date)
    WHERE event_type = 'ekadashi';
