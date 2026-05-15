# meditation/

Домен анализа джапы по данным Muse S Athena (EEG-повязка).

**Статус**: ✓ реализован полностью. 9 Edge Functions, 123 unit-теста, PWA-экраны, виджет на утреннем дашборде, Telegram-бот ветка.

## Источник данных

```
Muse Athena → Mind Monitor (Android) → CSV → Telegram-бот (share-intent)
            → parse-meditation-csv → meditation_sessions + Storage (gzip-CSV)
            → диалог: kind → circles → location → distracted → rating
            → compute-meditation-circles → meditation_circles + теги + интерпретации
            → enrich-meditation-with-whoop (sleep + recovery контекст)
            → PWA: /meditation/sessions.html, /meditation/trends.html + виджет /morning.html
```

У Muse нет публичного API — поэтому путь через CSV из Mind Monitor.

## Таблицы

| Таблица | Назначение | Миграция |
|---|---|---|
| `meditation_sessions` | Одна сессия. Сессионные агрегаты, timeline 30s, signal-shift, кэш Whoop, теги, интерпретации. | [017](../../infra/supabase/migrations/017_meditation.sql) |
| `meditation_circles` | Агрегаты по каждому кругу. Заполняется после подтверждения `circles` в боте. | 017 |
| `meditation_baseline` | Кэш средних: `period × calm_only` = 8 строк. 16-бинная нормализация по позиции. | 017 + [019](../../infra/supabase/migrations/019_meditation_baseline_avg_beta.sql) |
| `meditation_pending_session` | Состояние диалога Telegram. Один pending на пользователя. | 017 |

**Storage**: bucket `meditation-csv`, путь `{user_id}/{session_id}.csv.gz`, лимит 20 МБ ([018](../../infra/supabase/migrations/018_meditation_storage.sql)). RLS по первому сегменту пути = `auth.uid()`.

**Что переиспользуется из общей системы**:
- Локации — общая `locations` (миграция 002), не отдельная `meditation_locations`.
- `telegram_chat_id` — общий `user_profile` (миграция 012), не дублируется.
- Whoop-данные — JOIN с `whoop_sleeps` и `whoop_recovery` через enrich-функцию (кэш в `meditation_sessions`).

## Edge Functions

| Функция | verify_jwt | Триггер | Что делает |
|---|---|---|---|
| `parse-meditation-csv` | false | telegram-webhook после CSV | CSV → агрегаты + timeline 30s + signal-shift детектор. Не разбивает на круги. |
| `compute-meditation-circles` | false | telegram-webhook после `circles` | Разбивка по кругам, deepening, longest_calm (P75), duration_category, теги, интерпретации. Триггерит recompute и enrich. |
| `recompute-meditation-baseline` | false | compute, toggle, lazy | 8 baseline-строк (4 периода × 2 calm). 16-бинная нормализация по позиции. |
| `enrich-meditation-with-whoop` | false | async из compute + sweep | Sleep и recovery контекст. После 7 дней без данных перестаёт пытаться. |
| `get-session-report` | true | PWA: экран сессии | `SessionReport`. Lazy recompute baseline. |
| `get-trends-report` | true | PWA: экран статистики | `TrendsReport`: сессии за период + SMA-7 + 4 корреляции (Spearman). |
| `get-japa-summary-widget` | true | PWA: виджет на главной | 5 состояний: `no_sessions / pending_context / stale / fresh+metrics / fresh+noCompareReason`. |
| `toggle-session-exclusion` | true | PWA: кнопка | Флип `excluded_from_stats`, пересчёт baseline. |
| `telegram-webhook` (ветка джапы) | false | Telegram update | CSV-документ + диалог 5 шагов + `/last`, `/stats`, `/cancel`. |

## Ключевые формулы

- **Углубление** (`deepening_pct`): `(theta_last_third - theta_first_third) / theta_first_third × 100`. NULL если `theta_first_third < 1%` (защита от деления). `reliable=false` при потолке `|Δ| > 200%` или наличии signal-shift.
- **Стабильность** (`ab_index_median`): медиана Alpha/Beta индекса по сессии. Чем выше — тем меньше «болтающего ума».
- **Calm-окно**: 30-сек окно, где `ab_index > P75` по этой сессии. Не глобальный порог, не «Beta < ср.» — относительный к сессии.
- **Longest calm**: самый длинный непрерывный run calm-окон, минимум 30 сек. Считается только до точки signal-shift.
- **Signal-shift**: резкая ступенька в band-powers — Theta ×2.5 ИЛИ Alpha ×0.4 за 30с, удержание 5 мин. HSI этого не ловит.
- **Calm-only baseline** зависит от технического качества (`signal_quality_pct ≥ 80`, нет `shift=high`, `deepening_reliable=true`), **НЕ** от `self_rating`/`distracted` (иначе circular reasoning).
- **Duration_category**: `standard` если ±25% от персональной медианы за 30 дней (≥5 сессий). Short/long не входит в baseline, не получает compare.
- **Корреляции**: Spearman (непараметрический). Significant: `|r| > 0.3 AND n ≥ 14`.

## Тон и линт

Все интерпретации — **шаблоны в коде**, не LLM. Версия в `INTERPRETATION_VERSION = 'v1'`. Лит-функция `assertNoForbidden` ловит запрещённые слова («идеально», «молодец», «продолжай в том же духе», «к сожалению», эмодзи) при генерации.

## PWA

| Маршрут | Что показывает |
|---|---|
| `/meditation/sessions.html?id=<uuid>` | Экран сессии: signal, главный график (3 формы), calm-strip, фазы, теги, compare per-circle |
| `/meditation/trends.html` | Статистика: period+calm toggle, summary, 2 trend chart + SMA-7, 4 correlation cards |
| `/morning.html` | Виджет джапы на дашборде |
| `/meditation/_preview*.html` | Design-preview без auth/API, mock-данные inline |

Стек: Vanilla TS + Tailwind CDN + DaisyUI + чистый SVG (без D3/Recharts). Компоненты в `frontend/js/meditation/` (api / shared / charts / render-session / render-trends / widget).

## Тестирование

- `tests/meditation/` — 123 unit-теста (Deno).
- Эталонные CSV-фикстуры в `tests/fixtures/meditation/*.csv.gz` (gzip — тот же формат, что в проде).
- Запуск: `deno test --allow-read tests/meditation/`
- Покрытие: parser (5), compute (9), tags (16), interpretations (20), report (21), trends (16), baseline (16), correlations (20).

## Документы

- ТЗ: `japa-code-brief.md` + `japa-widget-addendum.md` (в `~/Downloads/`, не в репо)
- Дизайн: handoff с 3 артбордами (session / comparison forms / trends)
- При расхождениях: метрики/структура — ТЗ, визуальное оформление — дизайн.
