-- 024_meditation_zones.sql
-- «Светофор» устойчивости ума: зоны 0/1/2 от внешнего монитора.
-- Источник — опциональная колонка Zone в CSV. Без неё всё остаётся как сейчас.
--
-- Применено к prod (intcymsjpbkyrflfcwzf) через mcp__supabase__apply_migration
-- параллельно с этим коммитом.
--
-- Rollback:
--   ALTER TABLE meditation_circles DROP COLUMN zone_samples, DROP COLUMN zone_red_pct,
--     DROP COLUMN zone_yellow_pct, DROP COLUMN zone_green_pct;
--   ALTER TABLE meditation_sessions DROP COLUMN zone_red_pct, DROP COLUMN zone_yellow_pct,
--     DROP COLUMN zone_green_pct, DROP COLUMN zone_log;

ALTER TABLE meditation_sessions
    ADD COLUMN zone_log jsonb,
    ADD COLUMN zone_green_pct numeric(5,1),
    ADD COLUMN zone_yellow_pct numeric(5,1),
    ADD COLUMN zone_red_pct numeric(5,1);

COMMENT ON COLUMN meditation_sessions.zone_log IS
    'История зон «спидометра устойчивости» от внешнего монитора: [{t_sec, zone}], zone 0/1/2 = зелёная/жёлтая/красная. NULL = монитор не писал зоны (телефонный экспорт или старая сессия).';
COMMENT ON COLUMN meditation_sessions.zone_green_pct IS
    'Доля времени всей сессии в зелёной зоне, %. NULL = zone_log отсутствует.';
COMMENT ON COLUMN meditation_sessions.zone_yellow_pct IS
    'Доля времени всей сессии в жёлтой зоне, %. NULL = zone_log отсутствует.';
COMMENT ON COLUMN meditation_sessions.zone_red_pct IS
    'Доля времени всей сессии в красной зоне, %. NULL = zone_log отсутствует.';

ALTER TABLE meditation_circles
    ADD COLUMN zone_green_pct numeric(5,1),
    ADD COLUMN zone_yellow_pct numeric(5,1),
    ADD COLUMN zone_red_pct numeric(5,1),
    ADD COLUMN zone_samples int;

COMMENT ON COLUMN meditation_circles.zone_samples IS
    'Число валидных Zone-замеров (≈ секунд), попавших в интервал круга. 0 = в этом круге монитор зон не писал; NULL = у сессии вообще нет zone_log.';
COMMENT ON COLUMN meditation_circles.zone_green_pct IS
    'Доля времени круга в зелёной зоне, %. NULL при zone_samples = 0 или у сессии нет zone_log.';
COMMENT ON COLUMN meditation_circles.zone_yellow_pct IS
    'Доля времени круга в жёлтой зоне, %. NULL при zone_samples = 0 или у сессии нет zone_log.';
COMMENT ON COLUMN meditation_circles.zone_red_pct IS
    'Доля времени круга в красной зоне, %. NULL при zone_samples = 0 или у сессии нет zone_log.';
