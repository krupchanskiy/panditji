-- 021_tasks_realtime.sql
-- Подключаем tasks к Realtime-публикации, чтобы PWA получала INSERT/UPDATE/DELETE
-- (бот создал задачу → задача появилась в открытом окне без рефреша).
-- Rollback: ALTER PUBLICATION supabase_realtime DROP TABLE tasks;

ALTER PUBLICATION supabase_realtime ADD TABLE tasks;
