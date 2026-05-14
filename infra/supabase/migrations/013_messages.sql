-- 013_messages.sql
-- Сгенерированные сообщения Пандитджи (утреннее приветствие, инсайты и т.п.).
-- Хранятся как кэш: одно сообщение на (user, date, kind) — генерируется лениво.
-- Rollback: DROP TABLE messages;

CREATE TABLE messages (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    date             date NOT NULL,
    kind             text NOT NULL DEFAULT 'morning',

    content          text NOT NULL,
    model            text,
    context_snapshot jsonb,

    generated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, date, kind)
);

COMMENT ON TABLE  messages           IS 'Сообщения Пандитджи: утреннее приветствие, инсайты, ответы на чек-ин. Кэшируются по (user, date, kind).';
COMMENT ON COLUMN messages.kind      IS 'morning | evening | insight | telegram_reply ...';
COMMENT ON COLUMN messages.content   IS 'Готовый текст. Допустимы только <em>...</em> теги, остальное экранируется на фронте.';
COMMENT ON COLUMN messages.context_snapshot IS 'Что было в контексте при генерации (для отладки и пере-генерации).';

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON messages
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE INDEX idx_messages_user_date ON messages(user_id, date DESC);
