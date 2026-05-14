-- 004_oauth_tokens.sql
-- Метаданные OAuth-токенов внешних API. Сами токены — в supabase_vault.
-- Rollback: DROP TABLE oauth_tokens;

CREATE TABLE oauth_tokens (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    provider                text NOT NULL,

    access_token_secret_id  uuid NOT NULL,
    refresh_token_secret_id uuid,

    expires_at              timestamptz,
    scopes                  text[],

    is_active               boolean NOT NULL DEFAULT true,
    last_used_at            timestamptz,
    last_error              text,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id, provider)
);

COMMENT ON TABLE  oauth_tokens                        IS 'Метаданные OAuth-токенов внешних API. Сами токены — в supabase_vault.';
COMMENT ON COLUMN oauth_tokens.provider               IS 'Имя провайдера: whoop, withings, google.';
COMMENT ON COLUMN oauth_tokens.access_token_secret_id IS 'vault.secrets.id с access_token. Получать через vault.decrypted_secrets.';
COMMENT ON COLUMN oauth_tokens.is_active              IS 'false если refresh упал — cron-функции пропускают такого провайдера.';
COMMENT ON COLUMN oauth_tokens.last_error             IS 'Последняя ошибка refresh. Не NULL = нужна переавторизация пользователя.';

ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_owns_data" ON oauth_tokens
    FOR ALL
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE TRIGGER trigger_update_updated_at
    BEFORE UPDATE ON oauth_tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
