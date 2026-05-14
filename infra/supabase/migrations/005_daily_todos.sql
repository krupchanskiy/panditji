-- 005_daily_todos.sql
-- Утренние чекбоксы: вода, взвешивание, джапа сразу.
-- daily_todos             — определения дел (по 1 строке на дело)
-- daily_todo_completions  — отметки выполнения за конкретный день
-- Rollback: DROP TABLE daily_todo_completions; DROP TABLE daily_todos;

CREATE TABLE daily_todos (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    todo_key      text NOT NULL,
    emoji         text NOT NULL,
    emoji_variant text NOT NULL,
    label         text NOT NULL,
    sort_order    int  NOT NULL DEFAULT 0,
    is_active     boolean NOT NULL DEFAULT true,

    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, todo_key)
);

COMMENT ON TABLE  daily_todos               IS 'Определения утренних чекбоксов. Стабильный список дел, повторяющихся ежедневно.';
COMMENT ON COLUMN daily_todos.todo_key      IS 'Стабильный ID: water, scale, japa. На нём строятся графики выполнения, не меняется.';
COMMENT ON COLUMN daily_todos.emoji_variant IS 'Какую цветную плашку под эмодзи показать: water | scale | bell.';
COMMENT ON COLUMN daily_todos.is_active     IS 'false = дело скрыто из утреннего списка, но история выполнения сохранена.';

ALTER TABLE daily_todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON daily_todos
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE TRIGGER trigger_update_updated_at
    BEFORE UPDATE ON daily_todos
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();


CREATE TABLE daily_todo_completions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    todo_id      uuid NOT NULL REFERENCES daily_todos(id) ON DELETE CASCADE,
    date         date NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, todo_id, date)
);

COMMENT ON TABLE  daily_todo_completions      IS 'Отметка о выполнении дела за конкретный день. Нет записи = не сделано.';
COMMENT ON COLUMN daily_todo_completions.date IS 'Локальная дата пользователя в его текущей зоне. Считается на клиенте/сервере по timezone.';

ALTER TABLE daily_todo_completions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON daily_todo_completions
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE INDEX idx_daily_todo_completions_user_date ON daily_todo_completions(user_id, date DESC);
