# meditation/

Домен анализа джапы по данным Muse S Athena (EEG-повязка).

## Источник данных

```
Muse Athena → Mind Monitor (Android) → CSV → Telegram-бот (share-intent)
            → parse-meditation-csv → Supabase (meditation_sessions + Storage)
            → диалог в боте (kind, circles, place, distracted, rating)
            → compute-meditation-circles → meditation_circles + теги + интерпретации
            → enrich-meditation-with-whoop (отложенно)
            → PWA: /meditation/sessions/:id и /meditation/trends
```

У Muse нет публичного API — поэтому путь через CSV из Mind Monitor.

## Таблицы

| Таблица | Назначение |
|---|---|
| `meditation_sessions` | Одна сессия джапы. Сессионные агрегаты, timeline 30s, кэш Whoop-контекста, теги, интерпретации. |
| `meditation_circles` | Агрегаты по каждому кругу. Заполняется после подтверждения `circles` в боте. |
| `meditation_baseline` | Кэш средних по сессиям за период (`w`/`m`/`q`/`all` × `calm_only`). Пересчитывается лениво. |
| `meditation_pending_session` | Состояние диалога Telegram-бота. Один pending на пользователя. |

Локации — общая `locations` (миграция 002). `telegram_chat_id` — общий `user_profile` (миграция 012).

CSV хранится в Storage bucket `meditation-csv` по пути `{user_id}/{session_id}.csv.gz` — для re-parse при апгрейде парсера.

## Edge Functions (план)

| Функция | Триггер | Делает |
|---|---|---|
| `parse-meditation-csv` | Telegram-webhook после получения CSV | Парсит CSV → сессионные агрегаты, timeline, signal-shift детектор. Циклы не считает. |
| `compute-meditation-circles` | Telegram-webhook после подтверждения circles | Разбивка по кругам, deepening, longest_calm, авто-теги, интерпретации. |
| `enrich-meditation-with-whoop` | Сразу после circles + почасовой cron | Подтягивает сон/recovery из `whoop_*` за сутки до сессии. |
| `get-session-report` | PWA `/meditation/sessions/:id` | Отдаёт `SessionReport`. Пересчитывает baseline лениво. Ремигрирует интерпретации при смене версии. |
| `get-trends-report` | PWA `/meditation/trends` | Тренды, SMA-7, корреляции (Spearman). |
| `get-japa-summary-widget` | PWA `/` (главная) | Виджет: последняя сессия + сравнение с 30-дневным baseline. |
| `toggle-session-exclusion` | PWA — кнопка «исключить/включить» | Меняет `excluded_from_stats`, пересчитывает baseline. |

Telegram-flow джапы — ветка в существующей `telegram-webhook`, не отдельный webhook (у бота один webhook URL).

## Ключевые формулы

- **Углубление** (`deepening_pct`) — `(theta_last_third − theta_first_third) / theta_first_third × 100`. NULL если `theta_first_third < 1%` (защита от деления).
- **Стабильность** (`ab_index_median`) — медиана Alpha/Beta по сессии.
- **Calm-окно** — 30-сек окно, где `ab_index > P75` по этой сессии (не глобальный порог, не Beta < ср.).
- **Сигнал-shift** — резкая ступенька в данных: Theta ×2.5 или Alpha ×0.4 за 30с с удержанием 5 мин. HSI этого не ловит.
- **Категория длительности** — `standard` если ±25% от персональной медианы за 30 дней (при ≥5 сессий в базе), иначе `short`/`long`. Нестандартные не входят в baseline.

## Документы

- ТЗ домена: `japa-code-brief.md` + `japa-widget-addendum.md` (вне репо, в `~/Downloads/`)
- Дизайн-handoff: `design_handoff_japa/` — три артборда (session, comparison forms, trends)

При расхождениях в **метриках или структуре данных** — приоритет за ТЗ. При расхождениях в **визуальном оформлении** — приоритет за дизайном.
