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

## Структура

```
panditji/
├── CLAUDE.md           Правила для Claude Code (Karpathy + проектное)
├── docs/               Документация проекта
├── domains/            9 доменов системы:
│                       continuous_biometrics, daily_measurements, meditation,
│                       blood_tests, calendar, astrology, memories, check_ins, messages
├── frontend/           PWA (Vanilla TypeScript + Tailwind + DaisyUI)
└── infra/
    ├── supabase/       Миграции БД, Edge Functions
    └── shrsk/          Python-jobs на ШРСК-сервере (gaurabda и др.)
```

## Стек

- **БД:** Supabase Cloud, регион Mumbai (`ap-south-1`), Pro tier
- **Сервер:** Edge Functions на Deno/TypeScript
- **Python-jobs:** Docker на ШРСК-сервере (gaurabda для вайшнава-календаря)
- **Фронт:** PWA, Vanilla TypeScript + Tailwind + DaisyUI 4.x, без сборки
- **ИИ:** Anthropic Claude API (Sonnet 4.6 / Opus 4.7)
- **Деплой:** GitHub Pages (фронт) + Supabase CLI (Edge Functions)

## Статус

**Phase 0 — подготовка инфраструктуры.** Внешние сервисы зарегистрированы:

- Whoop OAuth, Withings OAuth, Telegram Bot
- Google Calendar API
- Supabase Cloud (Mumbai, Pro)
- Anthropic Claude API

Следующий этап — Phase 1: ядро MVP (Whoop + Withings + утренний экран).
