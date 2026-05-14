-- 003_user_profile.sql
-- Расширение auth.users. id совпадает с auth.users(id) — нет отдельного auth_user_id.
-- Rollback: DROP TABLE user_profile;

CREATE TABLE user_profile (
    id                  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

    spiritual_name      text NOT NULL,
    full_name           text NOT NULL,
    short_name          text NOT NULL,

    birth_date          date NOT NULL,
    birth_time          time NOT NULL,
    birth_tz            text NOT NULL,
    birth_lat           numeric(9,6) NOT NULL,
    birth_lon           numeric(9,6) NOT NULL,
    birth_place         text NOT NULL,

    height_cm           int NOT NULL,

    primary_lang        text NOT NULL DEFAULT 'ru',
    current_location_id uuid REFERENCES locations(id),

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  user_profile                     IS 'Расширение auth.users. id совпадает с auth.users(id).';
COMMENT ON COLUMN user_profile.spiritual_name      IS 'Имя для обращения системы: "Ачинтья Кришна джи".';
COMMENT ON COLUMN user_profile.short_name          IS 'Короткое обращение: "Ачинтья джи".';
COMMENT ON COLUMN user_profile.birth_tz            IS 'IANA-имя зоны рождения, для натальной карты.';
COMMENT ON COLUMN user_profile.current_location_id IS 'Где пользователь сейчас. Обновляется автоматически из flights или вручную при переезде без перелёта.';

ALTER TABLE user_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON user_profile
    FOR ALL
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

CREATE TRIGGER trigger_update_updated_at
    BEFORE UPDATE ON user_profile
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
