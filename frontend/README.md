# frontend/

PWA на Vanilla TypeScript + Tailwind + DaisyUI 4.x. Без фреймворков (React/Vue/Svelte), без сборки.

Подробности — в `docs/architecture.md`, раздел 3.3 и 10.

## Принципы

- **Auth-First Rendering** — ничего не рендерим до подтверждения авторизации
- **`DateUtils.parseDate()`** для всех дат-строк (часовые пояса!)
- **`Layout`** как центральный хаб с `.t()`, `.db`, `.handleError()`
- **Event delegation** через `data-action="..."`
- **Inline SVG** для иконок (никаких эмодзи)

## Структура (TBD)

Будет наполняться по мере разработки.
