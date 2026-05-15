# domains/

Девять доменов системы. Каждый — отдельный модуль со своими таблицами, Edge Functions и API. Домены общаются **через БД**, не напрямую.

Подробности архитектуры — в `docs/architecture.md`, раздел 4 «Домены и провайдеры».

## Текущий статус

| № | Домен | Источник | Папка | Статус |
|---|---|---|---|---|
| 1 | **continuous_biometrics** | Whoop API | (логика в `supabase/functions/whoop-*`) | ✓ работает (fetcher, init, callback) |
| 2 | **daily_measurements** | Withings API | — | ⏳ в плане |
| 3 | **meditation** | Muse → Mind Monitor → Telegram | [`meditation/`](meditation/) | ✓ **готов полностью** (9 EF, 123 теста, PWA + виджет) |
| 4 | **blood_tests** | Ручная загрузка фото | — | ⏳ в плане |
| 5 | **calendar** | Google Calendar + Telegram | (логика в `supabase/functions/google-*` + `telegram-webhook`) | ✓ работает (диктовка встреч из Telegram) |
| 6 | **astrology** | Swiss Ephemeris + gaurabda | (логика в `supabase/functions/astro-api`) | ✓ работает (натальная карта, транзиты, вайшнава-календарь) |
| 7 | **memories** | Claude + ручное | — | ⏳ в плане |
| 8 | **check_ins** | Ручной микро-ввод | — | ⏳ частично (`daily_todos` + `daily_todo_completions`) |
| 9 | **messages** | Claude API | (логика в `supabase/functions/morning-message`) | ✓ работает (утренние сообщения) |

**Реально папка только у `meditation/`** — она вырезана как полноценный модуль с README, edge functions, тестами. Остальные «домены» пока живут как Edge Functions в `supabase/functions/`, без отдельной директории-модуля.

## Целевая структура каждого домена

```
<domain>/
├── README.md        Что делает домен, какие таблицы, какие edge functions
├── tables.sql       (опционально) — ссылка на основную миграцию в infra/supabase/migrations/
├── api.ts           Функции чтения (если используются из других доменов)
├── fetchers.ts      Забор данных из внешних источников
└── aggregator.ts    Daily/weekly агрегация
```

Сейчас в `meditation/` есть только `README.md` — остальная логика разнесена по `supabase/functions/<name>/` и `frontend/js/meditation/`. Когда добавится второй полноценный домен — пересмотрим, надо ли поднимать всё в `domains/<name>/`.
