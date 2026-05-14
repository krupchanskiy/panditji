-- 011_calendar_events.sql
-- События календаря: чтение из Google Calendar + добавление через Telegram-бот.
-- Идемпотентность через google_event_id (UNIQUE).
-- Rollback: DROP TABLE calendar_events;

CREATE TABLE calendar_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    google_event_id     text UNIQUE,
    google_calendar_id  text,

    title               text NOT NULL,
    description         text,
    location_text       text,

    start_at            timestamptz NOT NULL,
    end_at              timestamptz,
    is_all_day          boolean NOT NULL DEFAULT false,
    timezone            text NOT NULL,

    category            text,

    source              text NOT NULL,

    deleted_at          timestamptz,
    last_synced_at      timestamptz,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  calendar_events                IS 'Календарные события: зеркало Google Calendar + ручной ввод через Telegram.';
COMMENT ON COLUMN calendar_events.google_event_id IS 'ID события в Google. Идемпотентность при повторных fetch.';
COMMENT ON COLUMN calendar_events.timezone        IS 'IANA-зона события (как пришла из Google или из контекста пользователя).';
COMMENT ON COLUMN calendar_events.category        IS 'meeting | travel | lecture | practice | personal | NULL — определяется автоматически или вручную.';
COMMENT ON COLUMN calendar_events.source          IS 'google_calendar | telegram_voice | telegram_text | panditji | manual';
COMMENT ON COLUMN calendar_events.deleted_at      IS 'Soft delete: событие удалено в Google или вручную.';

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON calendar_events
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE TRIGGER trigger_update_updated_at
    BEFORE UPDATE ON calendar_events
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_calendar_events_user_date ON calendar_events(user_id, start_at);
CREATE INDEX idx_calendar_events_google ON calendar_events(google_event_id) WHERE google_event_id IS NOT NULL;
