-- 001_init.sql
-- Расширения и универсальная триггер-функция updated_at.
-- Rollback: DROP FUNCTION update_updated_at(); DROP EXTENSION supabase_vault; DROP EXTENSION pgcrypto;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.update_updated_at() IS 'Триггерная функция для обновления updated_at при UPDATE.';
