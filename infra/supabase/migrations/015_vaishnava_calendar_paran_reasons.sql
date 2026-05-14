-- 015_vaishnava_calendar_paran_reasons.sql
-- gaurabda даёт два отдельных кода: причина начала и причина конца паран-окна.
-- Разделяем paran_type на paran_start_reason / paran_end_reason. Сам paran_type
-- оставляем как полный человеко-читаемый ярлык (start_reason:end_reason или произвольный).

ALTER TABLE vaishnava_calendar
    ADD COLUMN paran_start_reason text,
    ADD COLUMN paran_end_reason   text;

COMMENT ON COLUMN vaishnava_calendar.paran_start_reason IS 'Причина начала окна: sunrise | tithi_end | naksatra_end | 4tithi_end | 3day.';
COMMENT ON COLUMN vaishnava_calendar.paran_end_reason   IS 'Причина конца окна: sunrise | tithi_end | naksatra_end | 4tithi_end | 3day.';
