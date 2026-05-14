# infra/shrsk/

Python-jobs, работающие на ШРСК-сервере. Используются для задач, которые не могут работать в Supabase Edge Functions (Deno).

## Что здесь будет

- **gaurabda-job/** — расчёт вайшнава-календаря раз в месяц на 2 года вперёд для Москвы и Говардхана. Пишет результат в Supabase через REST API.
- **blood-test-parser/** — опционально, если потребуется продвинутый PDF-парсинг (Camelot для табличных PDF).
- **backups/** — ежедневный `pg_dump` от Supabase Cloud, ретенция 30 дней локально.
- **monitoring/** — Uptime Kuma + Telegram алерты.

## Деплой

Через Docker Compose. Cron на ШРСК запускает `docker exec` по расписанию.
