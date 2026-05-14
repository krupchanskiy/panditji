-- 012_user_profile_telegram.sql
-- Добавляем привязку Telegram-аккаунта к user_profile.
-- telegram_chat_id — куда боту слать сообщения. NULL = не привязан.
-- telegram_link_token — одноразовый секрет для команды /start <token>.
-- Rollback: ALTER TABLE user_profile DROP COLUMN telegram_chat_id, DROP COLUMN telegram_link_token;

ALTER TABLE user_profile
    ADD COLUMN telegram_chat_id    bigint UNIQUE,
    ADD COLUMN telegram_link_token text   UNIQUE;

COMMENT ON COLUMN user_profile.telegram_chat_id    IS 'Telegram chat_id для отправки сообщений ботом. NULL = аккаунт не привязан.';
COMMENT ON COLUMN user_profile.telegram_link_token IS 'Одноразовый токен для команды /start <token>. После использования обнуляется.';

CREATE INDEX idx_user_profile_telegram_chat_id ON user_profile(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
