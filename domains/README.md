# domains/

Девять доменов системы. Каждый — отдельный модуль со своими таблицами, Edge Functions и API.

Подробности — в `docs/architecture.md`, раздел 4 «Домены и провайдеры».

## Домены MVP

1. **continuous_biometrics/** — Whoop (HRV, сон, ЧСС, активность)
2. **daily_measurements/** — Withings (вес, ЭКГ, состав тела)
3. **meditation/** — Muse → Mind Monitor → Telegram (EEG джапы)
4. **blood_tests/** — анализы крови (Claude парсит фото)
5. **calendar/** — Google Calendar + ручной ввод
6. **astrology/** — Swiss Ephemeris (натальная карта, транзиты) + gaurabda (вайшнава-календарь)
7. **memories/** — долговременная память для Claude
8. **check_ins/** — утренние/вечерние микро-чек-ины
9. **messages/** — генерация сообщений Пандитджи

Структура каждого домена:

```
<domain>/
├── tables.sql       Миграции БД
├── api.ts           Функции чтения
├── fetchers.ts      Забор данных из внешних источников
├── aggregator.ts    Daily/weekly агрегация
└── README.md        Что делает этот домен
```
