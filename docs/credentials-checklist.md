# Пандитджи — чек-лист доступов и ключей

Все внешние сервисы, к которым подключается Пандитджи. Заполнять по мере регистрации.

**Где хранятся секреты:** в личном password manager пользователя + в Supabase Edge Function secrets (после создания проекта). Никогда не в коде, не в Git, не в чатах.

---

## ✅ Whoop API

Статус: **зарегистрировано 2026-05-14**

- [x] Developer-аккаунт активирован
- [x] OAuth-приложение создано
- [x] Client ID получен
- [x] Client Secret сохранён в password manager пользователя
- [ ] **Production redirect URI** добавлен (после создания Supabase-проекта)
- [ ] Secret регенерирован (перед первым продакшен-деплоем)
- [ ] Secret загружен в Supabase Edge Function secrets

**URL портала:** developer.whoop.com

**Client ID** (можно публично):
```
32343bed-b301-4345-811b-101e8a929a74
```

**Redirect URIs:**
- `http://localhost:54321/functions/v1/whoop-oauth-callback` ✅ (для dev)
- `https://intcymsjpbkyrflfcwzf.supabase.co/functions/v1/whoop-oauth-callback` ⏳ (добавить позже)

**Scopes:**
- read:recovery
- read:cycles
- read:sleep
- read:workout
- read:profile
- read:body_measurement

---

## ✅ Withings API

Статус: **зарегистрировано 2026-05-14**

- [x] Developer-аккаунт зарегистрирован
- [x] OAuth-приложение создано (Public API integration)
- [x] Client ID получен
- [x] Client Secret сохранён в password manager пользователя
- [x] Redirect URIs указаны (dev: localhost; prod добавим после Supabase)
- [ ] **Production redirect URI** добавлен (после создания Supabase-проекта)
- [ ] Webhook URL добавлен (после Supabase)
- [ ] Secret загружен в Supabase Edge Function secrets

**URL портала:** developer.withings.com

**Client ID** (можно публично):
```
293bdd146ef07fd91ce600a65495b84777df56cd339ef0979ea62c67ff2b5b49
```

**Redirect URIs:**
- `http://localhost:54321/functions/v1/withings-oauth-callback` ✅ (для dev)
- `http://localhost:54321/functions/v1/withings-webhook` ✅ (для webhook в dev)
- `https://intcymsjpbkyrflfcwzf.supabase.co/functions/v1/withings-oauth-callback` ⏳ (добавить позже)
- `https://intcymsjpbkyrflfcwzf.supabase.co/functions/v1/withings-webhook` ⏳ (добавить позже)

**Важно:** на dev-режиме (localhost) Withings ограничивает приложение 10 пользователями. Для нас не проблема — один пользователь. Перед production-переходом нужно зарегистрировать настоящий HTTPS-URL.

---

## ✅ Google Cloud (для Calendar API)

Статус: **зарегистрировано 2026-05-14**

- [x] Google Cloud Project создан (`Pandit Ji`, организация `adrian.ru`)
- [x] Google Calendar API включён
- [x] OAuth Consent Screen настроен (Internal — Google Workspace)
- [x] OAuth Client ID создан (Web application)
- [x] Client Secret получен и сохранён в password manager пользователя
- [x] Production redirect URI настроен (`intcymsjpbkyrflfcwzf.supabase.co`)

**URL портала:** console.cloud.google.com

**Client ID** (можно публично):
```
948823532794-85ht5kpuf9kj2jd1r78rad0h7c2b1s73.apps.googleusercontent.com
```

**Redirect URIs:**
- `http://localhost:54321/functions/v1/google-oauth-callback` ✅ (для dev)
- `https://intcymsjpbkyrflfcwzf.supabase.co/functions/v1/google-oauth-callback` ✅ (для prod)

**Scopes:** `https://www.googleapis.com/auth/calendar`

**Примечание:** Drive API НЕ используется. Muse CSV приходят через Telegram-бот (Mind Monitor на Android не поддерживает автозагрузку в Drive — только share-меню).

---

## ✅ Telegram Bot

Статус: **создан 2026-05-14**

- [x] Бот создан через @BotFather
- [x] Bot Token получен и сохранён в password manager пользователя
- [ ] Имя бота / username: **записать в чек-лист**
- [ ] Webhook URL настроен (после создания Supabase-проекта)
- [ ] Bot Token загружен в Supabase Edge Function secrets

---

## ✅ Anthropic API (для Claude)

Статус: **активировано 2026-05-14**

- [x] Anthropic Console — аккаунт активирован
- [x] Биллинг настроен (нероссийская карта)
- [x] Первый депозит внесён
- [x] API Key создан (`Panditji Edge Functions`)
- [x] API Key сохранён в password manager пользователя
- [x] Monthly spend limit установлен ($20)
- [ ] API Key загружен в Supabase Edge Function secrets (когда дойдём до кода)

**URL портала:** console.anthropic.com

**Workspace:** Default (Адриан's)

**Используемые модели:**
- `claude-sonnet-4-6` — основная (утренние, парсинг, диалог)
- `claude-opus-4-7` — для недельных сводок (1-2 раза в неделю)

---

## ✅ Supabase Cloud

Статус: **создано 2026-05-14**

- [x] Supabase аккаунт активирован (`notamedia@gmail.com`, организация `Adrian Krupchanskiy`)
- [x] Тариф организации: **Pro** (даёт daily backups, 8GB БД, 100GB Storage)
- [x] Новый проект `Panditji` создан
- [x] Регион: `ap-south-1` (Mumbai) ✅
- [x] Compute: Micro
- [x] Database password сохранён в password manager пользователя
- [x] Publishable key получен
- [x] Secret key создан и сохранён в password manager пользователя
- [ ] JWT Secret сохранён (можно посмотреть в Settings → JWT)
- [x] **Custom Domain отложен** (стоит $10/мес add-on, не нужно для MVP)

**Project URL:**
```
https://intcymsjpbkyrflfcwzf.supabase.co
```

**Project Reference ID (для CLI):**
```
intcymsjpbkyrflfcwzf
```

**Publishable key** (можно публично, для фронта):
```
sb_publishable_IgyFEUad8sMGQSacSj3L_Q_NciIqamm
```

**Secret key** (хранится в password manager, используется в Edge Functions через `SUPABASE_SECRET_KEY`):
- Хранится у пользователя
- Также загружается в Supabase Edge Function secrets автоматически (доступен как `SUPABASE_SERVICE_ROLE_KEY`)

---

## ⏳ ШРСК-сервер

Статус: **нужны детали инфраструктуры**

- [ ] SSH-доступ есть
- [ ] Docker установлен
- [ ] cron / systemd timers работают
- [ ] Место для Python-jobs (gaurabda) выделено
- [ ] Доступ для бэкапов БД (от Supabase Cloud)

---

## ⏸ Доменное имя (отложено)

Статус: **отложено — используем дефолтный Supabase URL**

**Решение:** Custom Domain в Supabase стоит $10/мес add-on. Для нашего сценария (один пользователь, личный инструмент) это неоправданно. Используем дефолтный URL `https://intcymsjpbkyrflfcwzf.supabase.co`.

К custom domain можем вернуться позже, если:
- Решим мигрировать на self-hosted (нужна стабильная точка входа)
- Будем делиться публичным URL с кем-то
- Захочется красоты

**Пока используется:**
- API endpoint: `https://intcymsjpbkyrflfcwzf.supabase.co/rest/v1/`
- Edge Functions: `https://intcymsjpbkyrflfcwzf.supabase.co/functions/v1/...`
- Фронтенд (PWA): отдельно через GitHub Pages (бесплатно) — настроится позже

---

## Whoop App Tier и лимиты

*Зафиксировать после изучения Developer Portal:*

- [ ] App tier: **__________**
- [ ] Rate limit: **__________**
- [ ] Max retention of historical data: **__________**

---

## Календарная база (от знакомого)

- [x] Документ архитектуры от Сергея Оселедько получен ✅
- [ ] gaurabda установлен и протестирован локально
- [ ] Натальная карта Адриана сверена с известным разбором (если есть)

---

## Health data — текущий статус устройств

- [x] Whoop 5.0 — куплен, носится с 2026-05-13
- [x] Muse S Athena — куплен, начато использование с 2026-05-13
- [ ] Withings Body Smart — купить в Москве
- [ ] Withings Body Scan — купить в Индии после возвращения
- [ ] Withings BPM (отложено)

---

**Последнее обновление:** 2026-05-14
