-- 018_meditation_storage.sql
-- Storage bucket для gzip-сжатых CSV-файлов Mind Monitor.
-- Путь: meditation-csv/{user_id}/{session_id}.csv.gz
-- Размеры: raw CSV ~50 МБ → gzip ~3-5 МБ. Лимит 20 МБ с запасом.
--
-- Rollback: DELETE FROM storage.buckets WHERE id = 'meditation-csv';
--           DROP POLICY ... ON storage.objects;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'meditation-csv',
    'meditation-csv',
    false,
    20971520,  -- 20 MB
    ARRAY['text/csv', 'application/gzip', 'application/x-gzip', 'application/octet-stream']
)
ON CONFLICT (id) DO NOTHING;

-- RLS-политики на storage.objects.
-- Service role (telegram-webhook, parse-meditation-csv) обходит RLS — Edge Functions работают
-- от лица сервиса, не пользователя. RLS здесь для будущего прямого доступа из PWA, если потребуется.
-- Структура пути: первый сегмент = user_id, поэтому (storage.foldername(name))[1] = uid().

CREATE POLICY "users_select_own_meditation_csv"
    ON storage.objects FOR SELECT
    USING (
        bucket_id = 'meditation-csv'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

CREATE POLICY "users_insert_own_meditation_csv"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'meditation-csv'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

CREATE POLICY "users_delete_own_meditation_csv"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'meditation-csv'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );
