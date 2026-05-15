# Пандитджи

Личная ИИ-система для отслеживания здоровья, практики и обучения одного пользователя — вайшнава, живущего между Говардханом и Москвой.

Не SaaS, не публичный продукт.

## Документация

- **[docs/vision.md](docs/vision.md)** — образ результата, сценарии, тон сообщений
- **[docs/summary.md](docs/summary.md)** — что строим, зачем, какое железо
- **[docs/architecture.md](docs/architecture.md)** — полная техническая архитектура
- **[docs/language-guide.md](docs/language-guide.md)** — язык генерации сообщений (на основе Соловьёва)
- **[docs/credentials-checklist.md](docs/credentials-checklist.md)** — статус всех внешних интеграций
- **[CLAUDE.md](CLAUDE.md)** — правила для Claude Code в этом репозитории
- **[domains/README.md](domains/README.md)** — список доменов и их статус
- **[domains/meditation/README.md](domains/meditation/README.md)** — детально про домен джапы

## Структура

```
panditji/
├── CLAUDE.md           Правила для Claude Code
├── docs/               Документация проекта
├── domains/            Домены системы (пока только meditation/ как полноценный модуль)
├── frontend/           PWA (Vanilla TypeScript + Tailwind + DaisyUI)
├── supabase/           Edge Functions (15+ функций на Deno)
├── tests/              Unit-тесты (Deno) — meditation/* покрыт
└── infra/
    ├── supabase/       Миграции БД (017+ для meditation)
    ├── shrsk/          Python-jobs на ШРСК-сервере (gaurabda и др.)
    └── github-actions/
```

## Стек

- **БД:** Supabase Cloud, регион Mumbai (`ap-south-1`), Pro tier (`intcymsjpbkyrflfcwzf`)
- **Сервер:** Edge Functions на Deno/TypeScript
- **Python-jobs:** Docker на ШРСК-сервере (gaurabda для вайшнава-календаря)
- **Фронт:** PWA, Vanilla TypeScript + Tailwind + DaisyUI 4.x, без сборки (CDN), деплой на GitHub Pages, custom domain `in.adrian.ru`
- **ИИ:** Anthropic Claude API (Sonnet 4.6 / Opus 4.7)
- **Деплой:** GitHub Pages (фронт) + Supabase CLI (Edge Functions)

## Статус

**Phase 1-2 MVP — в основном готов:**

- ✅ **Биометрика (Whoop)** — fetcher, OAuth, утренний экран
- ✅ **Google Calendar** — OAuth, диктовка встреч через Telegram (текст и голос)
- ✅ **Астрология** — Swiss Ephemeris + gaurabda для вайшнава-календаря
- ✅ **Утренний экран** — Sleep, Sleep Whoop, события дня, todos, виджет джапы
- ✅ **Telegram-бот** — единая точка входа: голос + текст → Claude → Calendar, CSV → парсер джапы
- ✅ **Meditation домен** — целиком: 9 Edge Functions, парсер Mind Monitor CSV, разбивка по кругам, deepening / longest_calm / baseline / 4 корреляции, PWA-экраны и виджет, 123 unit-теста. Детали — в `domains/meditation/README.md`
- ⏳ Withings (вес, ЭКГ) — в плане
- ⏳ Анализы крови (фото → Claude парсит) — в плане
- ⏳ Memories, check-ins, messages — частично

Следующие фазы — в `CLAUDE.md`, раздел 2.13.
