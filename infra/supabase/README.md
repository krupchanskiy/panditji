# infra/supabase/

Конфигурация и код Supabase Cloud (Mumbai, Pro tier).

## Структура

```
supabase/
├── migrations/      Нумерованные SQL-миграции (001_..., 002_..., ...)
└── functions/       Edge Functions на Deno/TypeScript
```

## Миграции

Применяются через Supabase CLI:

```bash
supabase migration up
```

Старые миграции не правятся — только новые. Подробности — в `docs/architecture.md`, раздел 5.0.12.

## Edge Functions

Деплой:

```bash
supabase functions deploy <name> --project-ref intcymsjpbkyrflfcwzf
```

Список Edge Functions (TBD) — будет наполняться по фазам разработки.
