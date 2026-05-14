-- 006_fix_update_updated_at_search_path.sql
-- Фиксим WARN от security advisor: функция должна иметь явный search_path.
-- Rollback: повторно CREATE OR REPLACE без SET search_path.

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;
