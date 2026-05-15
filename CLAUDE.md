# CLAUDE.md

Поведенческие гайдлайны для Claude Code в этом репозитории. Применяются вместе с проектной документацией в `docs/`.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

---

## Часть 1. Универсальные принципы

Базовые правила работы с кодом, не зависящие от конкретного проекта.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## Часть 2. Проект Пандитджи

Конкретика этого репозитория. Прочесть **до** того, как начать любую задачу.

### 2.1. Что это

Личная ИИ-система для отслеживания здоровья, практики и обучения одного пользователя. Это **не SaaS**, не приложение для рынка. Подробности — в `docs/vision.md`.

Один пользователь — Адриан (Ачинтья Кришна джи), вайшнав, живёт между Говардханом (7-8 мес/год) и Москвой (2-3 мес/год).

### 2.2. Стек

| Слой | Технология |
|---|---|
| База | Supabase Cloud (PostgreSQL), регион Mumbai (`ap-south-1`) |
| Серверная логика | Edge Functions на Deno/TypeScript |
| Python-jobs | Docker-контейнеры на ШРСК-сервере (cron) |
| Фронт | PWA, Vanilla TypeScript + Tailwind + DaisyUI 4.x, без сборки |
| ИИ | Anthropic Claude API (Sonnet 4.6 в основном, Opus 4.7 для weekly) |
| Деплой | GitHub Pages (фронт) + Supabase CLI (Edge Functions) |
| URL | `https://intcymsjpbkyrflfcwzf.supabase.co` (дефолтный Supabase, custom domain отложен) |
| Хостинг | Supabase Cloud (`intcymsjpbkyrflfcwzf.supabase.co`) |

**Никаких** React/Vue/Svelte. Никаких ORM. Никаких очередей. Один пользователь — минимум зависимостей.

### 2.3. Структура папок

```
panditji/
├── domains/                — 9 доменов, каждый со своими таблицами и API
│   ├── continuous_biometrics/  (Whoop)
│   ├── daily_measurements/     (Withings)
│   ├── meditation/             (Muse)
│   ├── blood_tests/
│   ├── calendar/
│   ├── astrology/
│   ├── memories/
│   ├── check_ins/
│   └── messages/
├── frontend/               — PWA
├── infra/
│   ├── supabase/migrations/    — нумерованные SQL-миграции
│   ├── shrsk/                  — Python-jobs (gaurabda, парсеры)
│   └── github-actions/
└── docs/
    ├── architecture.md     — полная архитектура (5000+ строк, читать обязательно)
    ├── vision.md           — образ результата
    └── language-guide.md   — язык генерации Пандитджи
```

Каждый домен — **отдельное маленькое приложение** со своими таблицами, функциями, API. Домены общаются **через БД**, не напрямую.

### 2.4. Ключевые архитектурные правила

Полностью — в `docs/architecture.md`, раздел 5.0. Кратко:

- **Идентификация:** `user_profile.id = auth.users.id`. Все FK на `auth.users(id) ON DELETE CASCADE`.
- **RLS:** включён + политика `user_id = auth.uid()` на каждой таблице. Без политики таблица недоступна.
- **Timestamps:** везде `timestamptz`. Часовые пояса — IANA (`'Europe/Moscow'`), никаких `+03:00`.
- **Upsert:** все вставки из внешних API через `ON CONFLICT (uid) DO UPDATE`. Никогда наивный INSERT.
- **Секреты:** OAuth-токены в Supabase Vault. В таблицах — только ссылки на `vault.secrets.id`.
- **Source-поле:** на каждой записи (`whoop_api`, `mind_monitor`, `telegram_voice`, ...).
- **Migrations:** нумерованные файлы `NNN_description.sql`. Старые не правятся, только новые.
- **COMMENT ON:** на всех нетривиальных полях и таблицах.

### 2.5. Source of Truth — кто прав при конфликте данных

| Метрика | Приоритет |
|---|---|
| Вес и состав тела | Withings → ручной ввод |
| Сон и HRV | Whoop (никогда не перезаписывается чек-ином) |
| Давление | Withings BPM → клинические измерения |
| ЭКГ | Withings Body Scan |
| Локация в моменте | flights (по arrival_at) → ручное переключение в profile |
| Календарь | Google Calendar → Telegram |

**Принцип:** объективные данные с устройств не перезаписываются субъективными чек-инами. Чек-ин — **дополнение** к биометрике, не альтернатива.

### 2.6. Язык кода и коммитов

**Код и комментарии в коде** — на английском. Имена переменных, функций, таблиц — английский.

**Коммиты, документация, сообщения PR** — на русском.

**Тексты для пользователя (UI, сообщения Пандитджи)** — на русском, в стиле, описанном в `docs/language-guide.md`.

### 2.7. Паттерны из ШРСК, которые мы наследуем

ШРСК-проект (ашрам-управление) — родственный по стеку. Мы заимствуем проверенные паттерны:

- **Auth-First Rendering** — ничего не рендерим до подтверждения авторизации
- **`DateUtils.parseDate()`** для дат-строк (`YYYY-MM-DD`). Критично из-за часовых поясов:
  ```javascript
  // ✓ Правильно — локальное время
  const d = DateUtils.parseDate('2026-02-09');
  // ✗ Неправильно — UTC, сдвиг на день
  const d = new Date('2026-02-09');
  ```
- **`Layout` как центральный хаб** — `.t()`, `.db`, `.handleError()`, `.showNotification()`
- **`Cache.getOrLoad(key, loaderFn, ttl)`** для дорогих запросов
- **Event delegation** через `data-action="..."` атрибуты
- **Inline SVG** для иконок. **Никаких эмодзи** в интерфейсе

### 2.8. Чего НЕ делать

**Системные запреты, которые часто соблазнительно нарушить:**

- ❌ React/Vue/любой фреймворк (Vanilla TypeScript)
- ❌ ORM поверх Supabase-клиента (использовать клиент напрямую)
- ❌ Превентивные индексы «на всякий случай» (только по факту медленных запросов)
- ❌ Очереди сообщений (RabbitMQ, Redis Queue — нет нагрузки)
- ❌ Микросервисы (это монолит на Edge Functions)
- ❌ Эмодзи в интерфейсе и в сообщениях Пандитджи
- ❌ Геймификация: streak, achievements, прогресс-бары «47% goal»
- ❌ A/B-тесты, аналитика поведения (это личный инструмент)
- ❌ Реализация на сейчас фичи Phase 2/3, когда работаем над Phase 1

### 2.9. Внешние API и rate limits

| API | Лимит | Стратегия |
|---|---|---|
| Whoop | 10 req/min, 100/hour | Cron раз в час, batch за 24h |
| Withings | 120 req/min | Cron раз в час |
| Google Calendar | 1M req/day | Cron + webhook |
| Anthropic | По модели | Контроль через `app_settings` |
| Telegram Bot | 30 msg/sec | Не достигаем при одном пользователе |

При получении 429 — exponential backoff, логирование в `jobs_log`. Не молчаливо игнорировать.

### 2.10. Обработка отсутствия данных

**Никогда не выдумывать данные.** Если Whoop не синхронизировался — на утреннем экране **прямо**: «Сегодня нет данных по сну». Пандитджи **не строит выводов** о дне без данных.

В `messages.content_data` — флаг `data_missing: ['whoop', 'muse']` для отладки.

### 2.11. OAuth failures

При неудачном refresh-token:
1. `oauth_tokens.last_error` заполняется
2. `oauth_tokens.is_active = false`
3. Cron-функции этого провайдера **тихо пропускают** работу (`WHERE is_active = true`)
4. Одно сообщение в Telegram пользователю — потом тишина

**Без режима "постоянно паникую".** Сломалось → один алерт → ждём действия пользователя.

### 2.12. Тесты

- **Юнит-тесты** обязательны для: расчётов астрологии, парсеров данных, baseline-логики
- Не покрываем 100% — это не SaaS, балансируем покрытие и скорость
- **Интеграционные тесты** для критичных потоков (OAuth → fetcher → DB)
- **E2E тесты** не делаем в MVP

### 2.13. Phases — что в MVP, что нет

**MVP (Phase 0-2):** биометрика, чек-ины, утренний экран, Telegram-бот, парсер анализов, астрология базовая, вайшнава-календарь, Muse-парсер.

**Что готово сейчас:**
- Whoop fetcher + утренний экран
- Google Calendar (диктовка через Telegram)
- Астрология + вайшнава-календарь
- **Meditation домен** — полностью: 9 Edge Functions, парсер CSV из Mind Monitor, разбивка по кругам, deepening / longest_calm / baseline / корреляции, Telegram-flow с диалогом, PWA-экраны (`/meditation/sessions.html`, `/meditation/trends.html`) и виджет на `/morning.html`. 123 unit-теста. См. `domains/meditation/README.md`.

**Phase 3 (после MVP):** SRS для шлок, SRS для хинди, лекции БВГ.

**Phase 4 (через 2-3 мес после старта):** ИИ-инсайты, корреляции, недельные сводки. *(Корреляции уже частично реализованы внутри `meditation` — Spearman + box-plot на странице трендов).*

**Phase 5 (опционально):** CGM-сессии, датчик воздуха, тонометр.

**Не реализуй фичи будущих фаз**, даже если кажется «легко добавить». Сначала закончи текущую фазу.

---

## Часть 3. Workflow с этим документом

### При начале новой задачи

1. Прочти текущий раздел `docs/architecture.md`, к которому относится задача
2. Если задача затрагивает несколько доменов — прочти соответствующие `domains/*/README.md`
3. Применяй принципы из Части 1 (Think Before Coding и т.д.)
4. Соблюдай конкретику из Части 2

### При сомнении

Если правило из Части 1 (Karpathy-гайдлайны) конфликтует с проектной конкретикой из Части 2 — побеждает **Часть 2**, но **озвучь конфликт** пользователю, не молчи.

### При обновлении правил

Этот файл — живой. Если в процессе разработки появились новые проектные правила, которые часто нарушаются — **добавляй их в Часть 2**. Не плоди отдельные документы.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
