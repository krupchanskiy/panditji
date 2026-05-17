-- 022_pending_calendar_event.sql
-- Состояние диалога «у тебя пересечение с другой встречей — что делать?».
-- Один pending на пользователя; при ответе (force/cancel) запись удаляется.
-- Rollback: DROP TABLE pending_calendar_event;

CREATE TABLE pending_calendar_event (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  event_payload  jsonb NOT NULL,
  tz             text NOT NULL,
  conflict_count int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  pending_calendar_event              IS 'Бот распарсил создание встречи, нашёл пересечение с существующими — ждёт inline-ответа пользователя в Telegram.';
COMMENT ON COLUMN pending_calendar_event.event_payload IS 'JSON: { title, start_at_iso, end_at_iso, location } — то, что Claude распарсил из сообщения.';
COMMENT ON COLUMN pending_calendar_event.tz           IS 'TZ пользователя на момент парсинга (нужна для повторной отправки в Google).';
COMMENT ON COLUMN pending_calendar_event.conflict_count IS 'Сколько пересечений нашли в БД на момент парсинга (для метрик).';

ALTER TABLE pending_calendar_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_owns_data ON pending_calendar_event
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
