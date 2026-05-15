-- 020_tasks.sql
-- Таск-трекер: задачи на день с датой и опциональным временем.
-- Создаются через PWA (поле ввода) или через Telegram-бота (голос/текст с префиксом-триггером).
-- Rollback: DROP TABLE tasks;

CREATE TABLE tasks (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    text                 text NOT NULL,
    notes                text,

    source               text NOT NULL CHECK (source IN ('web', 'telegram')),
    status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),

    due_date             date NOT NULL,
    due_time             time,

    snooze_count         int  NOT NULL DEFAULT 0,

    telegram_message_id  bigint,

    completed_at         timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  tasks                     IS 'Задачи таск-трекера. Группируются по due_date в локальной TZ пользователя.';
COMMENT ON COLUMN tasks.source              IS 'web — создано в PWA через поле ввода; telegram — распарсено из голоса/текста бота.';
COMMENT ON COLUMN tasks.status              IS 'open — активная; done — выполнена. Удаление физическое (без soft-delete).';
COMMENT ON COLUMN tasks.due_date            IS 'Локальная дата пользователя. Хвосты = due_date < today; Сегодня = due_date = today.';
COMMENT ON COLUMN tasks.due_time            IS 'Опциональное время в локальной TZ. Отображается как .badge-time под текстом задачи.';
COMMENT ON COLUMN tasks.snooze_count        IS 'Сколько раз задачу переносили (счётчик, без истории).';
COMMENT ON COLUMN tasks.telegram_message_id IS 'ID исходного сообщения в Telegram (если source=telegram). Для перехода к сообщению в чате.';
COMMENT ON COLUMN tasks.completed_at        IS 'Когда отметили выполненной. NULL пока status=open. Группировка "Сделано" — по date(completed_at, user_tz) = today.';

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON tasks
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE TRIGGER trigger_update_updated_at
    BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX idx_tasks_user_status_date ON tasks(user_id, status, due_date);
CREATE INDEX idx_tasks_user_completed   ON tasks(user_id, completed_at) WHERE status = 'done';
