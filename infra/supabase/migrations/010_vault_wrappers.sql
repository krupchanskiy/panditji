-- 010_vault_wrappers.sql
-- RPC-обёртки над supabase_vault для Edge Functions.
-- Edge Function использует service_role и зовёт эти функции; обычный пользователь — нет.
-- Rollback: DROP FUNCTION vault_read(uuid); DROP FUNCTION vault_store(text, text); DROP FUNCTION vault_update(uuid, text);

CREATE OR REPLACE FUNCTION public.vault_store(p_value text, p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_id uuid;
BEGIN
    v_id := vault.create_secret(p_value, p_name);
    RETURN v_id;
END
$$;

REVOKE ALL ON FUNCTION public.vault_store(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vault_store(text, text) TO service_role;

COMMENT ON FUNCTION public.vault_store(text, text) IS 'Сохраняет секрет в supabase_vault, возвращает его id. Только service_role.';


CREATE OR REPLACE FUNCTION public.vault_read(p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_value text;
BEGIN
    SELECT decrypted_secret INTO v_value
    FROM vault.decrypted_secrets
    WHERE id = p_id;
    RETURN v_value;
END
$$;

REVOKE ALL ON FUNCTION public.vault_read(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vault_read(uuid) TO service_role;

COMMENT ON FUNCTION public.vault_read(uuid) IS 'Расшифровывает секрет из supabase_vault по id. Только service_role.';


CREATE OR REPLACE FUNCTION public.vault_update(p_id uuid, p_value text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM vault.update_secret(p_id, p_value);
END
$$;

REVOKE ALL ON FUNCTION public.vault_update(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vault_update(uuid, text) TO service_role;

COMMENT ON FUNCTION public.vault_update(uuid, text) IS 'Обновляет существующий секрет в vault. Нужно при refresh OAuth-токена.';
