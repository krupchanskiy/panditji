-- 023_meditation_circle_markers.sql
-- Поддержка точных таймингов кругов из внешнего инструмента
-- (десктопный монитор медитации, пишущий CSV в формате Mind Monitor с
-- дополнительной колонкой Circle_Marker).
--
-- Обе колонки nullable, без default — старые сессии не затрагиваются,
-- телефонный экспорт Mind Monitor продолжает работать ровно как раньше.
--
-- Rollback:
--   ALTER TABLE meditation_sessions DROP COLUMN circles_source;
--   ALTER TABLE meditation_sessions DROP COLUMN circle_markers;

ALTER TABLE meditation_sessions
    ADD COLUMN circle_markers jsonb,
    ADD COLUMN circles_source text
        CHECK (circles_source IS NULL OR circles_source IN ('markers', 'manual', 'equal'));

COMMENT ON COLUMN meditation_sessions.circle_markers IS
    'Метки реального времени нажатия "круг!" из внешнего инструмента, если CSV содержал колонку Circle_Marker. Формат: [{"t_sec": 312.4, "count": 1}, ...]. t_sec — секунды от первой EEG-строки сессии. NULL = меток не было (телефонный экспорт Mind Monitor или старая сессия).';

COMMENT ON COLUMN meditation_sessions.circles_source IS
    'Откуда взяты границы кругов: markers = реальные тайминги из файла, sum(count) совпал с подтверждённым числом; manual = пользователь переопределил число, якоря использованы частично (хвост перераспределён или обрезан); equal = равные отрезки durationSec/circles (старое поведение для файлов без меток). NULL = compute ещё не отрабатывал.';
