/* Edge Function: telegram-webhook
 * Telegram шлёт сюда обновления. Принимаем три типа:
 *   /start <token>  — привязка chat_id к user_id (одноразовый token из telegram-link-init)
 *   /start          — подсказка как привязать
 *   текст           — отдаём в Claude, парсим интент создания встречи, если получилось —
 *                     POST в Google Calendar и upsert в calendar_events
 *
 * Безопасность: Telegram setWebhook поддерживает secret_token; проверяем его в заголовке. */

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import {
  handleCsvDocument, isCsvDocument,
  handleCallback, isMeditationCallback,
  tryHandlePendingText,
  handleLastCommand, handleStatsCommand,
} from './meditation.ts'
/* tasks.ts удалён — task-логика встроена в routeMessage через единый Claude-вызов. */

const TG_API = 'https://api.telegram.org'
const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-5'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REFRESH_BUFFER_MS = 5 * 60 * 1000

function ok() {
  return new Response('ok', { status: 200 })
}

async function sendTg(chatId: number, text: string): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  })
}

async function sendTyping(chatId: number): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  await fetch(`${TG_API}/bot${token}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  })
}

async function transcribeVoice(fileId: string): Promise<string | null> {
  const tgToken = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  const openaiKey = Deno.env.get('OPENAI_API_KEY')
  if (!openaiKey) {
    console.error('OPENAI_API_KEY not set')
    return null
  }

  /* 1. Получаем путь к файлу у Telegram. */
  const fileResp = await fetch(`${TG_API}/bot${tgToken}/getFile?file_id=${fileId}`)
  if (!fileResp.ok) {
    console.error('tg getFile failed', fileResp.status)
    return null
  }
  const fileData = await fileResp.json() as { ok: boolean; result?: { file_path: string } }
  if (!fileData.ok || !fileData.result?.file_path) return null

  /* 2. Скачиваем .ogg голосового сообщения. */
  const audioResp = await fetch(`${TG_API}/file/bot${tgToken}/${fileData.result.file_path}`)
  if (!audioResp.ok) {
    console.error('tg file download failed', audioResp.status)
    return null
  }
  const audioBlob = await audioResp.blob()

  /* 3. Отправляем в Whisper. */
  const form = new FormData()
  form.append('file', audioBlob, 'voice.ogg')
  form.append('model', 'whisper-1')
  form.append('language', 'ru')
  form.append('response_format', 'json')

  const whisperResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  })
  if (!whisperResp.ok) {
    const body = await whisperResp.text()
    console.error('whisper failed', whisperResp.status, body)
    return null
  }
  const result = await whisperResp.json() as { text?: string }
  return result.text?.trim() || null
}

async function googleAccessToken(admin: SupabaseClient, userId: string): Promise<string | null> {
  const { data: tok } = await admin
    .from('oauth_tokens')
    .select('access_token_secret_id, refresh_token_secret_id, expires_at, is_active')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle()
  if (!tok || !tok.is_active) return null

  const expiresMs = new Date(tok.expires_at).getTime()
  if (expiresMs - Date.now() < REFRESH_BUFFER_MS && tok.refresh_token_secret_id) {
    const { data: refreshToken } = await admin.rpc('vault_read', { p_id: tok.refresh_token_secret_id })
    if (!refreshToken) return null
    const resp = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken as string,
        client_id: Deno.env.get('GOOGLE_CLIENT_ID')!,
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
      }),
    })
    if (!resp.ok) return null
    const tokens = await resp.json() as { access_token: string; expires_in: number }
    await admin.rpc('vault_update', { p_id: tok.access_token_secret_id, p_value: tokens.access_token })
    await admin.from('oauth_tokens').update({
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      last_used_at: new Date().toISOString(),
      last_error: null,
    }).eq('user_id', userId).eq('provider', 'google')
    return tokens.access_token
  }

  const { data } = await admin.rpc('vault_read', { p_id: tok.access_token_secret_id })
  return data as string
}

/* Универсальный Claude-router: один вызов классифицирует сообщение в одну
 * из трёх категорий (task / event / chat) и одновременно даёт ответ в тоне
 * Пандитджи. Tone — сжатая выжимка из docs/language-guide.md. */
interface RoutedMessage {
  intent: 'create_task' | 'create_event' | 'chat'
  task?: { text: string; due_date: string; due_time: string | null }
  event?: { title: string; start_at_iso: string; end_at_iso: string; location?: string | null }
  reply: string
}

function localDate(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/* Возвращает таблицу-якорь дат с днями недели на сегодня + 13 следующих дней.
 * Нужна потому что LLM плохо считает день недели по дате — Sonnet регулярно
 * ошибается на 1 день, отчего «эта пятница» становится субботой и т.д. Со
 * списком в промпте Claude не считает, а просто выбирает строку. */
const RU_WEEKDAYS = [
  'воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота',
]
function buildDateAnchors(tz: string): string {
  const todayStr = localDate(tz)
  const [y, m, d] = todayStr.split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d))
  const lines: string[] = []
  for (let i = 0; i < 14; i++) {
    const dt = new Date(base.getTime() + i * 86400000)
    const iso = dt.toISOString().slice(0, 10)
    const wd = RU_WEEKDAYS[dt.getUTCDay()]
    let prefix: string
    if (i === 0) prefix = 'сегодня'
    else if (i === 1) prefix = 'завтра'
    else if (i === 2) prefix = 'послезавтра'
    else prefix = `через ${i} дн.`
    lines.push(`- ${iso} — ${wd} (${prefix})`)
  }
  return lines.join('\n')
}

async function routeMessage(text: string, tz: string, userShortName: string): Promise<RoutedMessage> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return { intent: 'chat', reply: 'У меня сейчас выключен голос. Попробуй позже.' }
  }
  const today = localDate(tz)
  const nowUtc = new Date().toISOString()
  const anchors = buildDateAnchors(tz)

  const sysPrompt = `Ты Пандитджи — личный ассистент в Telegram-боте. Обращаешься к пользователю «${userShortName}». Получаешь сообщение по-русски и сам решаешь, что это: задача, встреча, или вопрос/диалог.

КОНТЕКСТ
- Сегодняшняя локальная дата пользователя: ${today}
- Часовая зона: ${tz}
- Сейчас (UTC): ${nowUtc}

КАЛЕНДАРЬ-ЯКОРЯ (используй ТОЛЬКО эти даты, ничего не вычисляй сам)
${anchors}

Как пользоваться якорями:
- «завтра» → строка «завтра» в якорях.
- «эта/в эту/в эту ближайшую <день недели>» → ПЕРВАЯ сверху строка с этим днём недели.
- «следующий/в следующий <день недели>» → ВТОРАЯ сверху строка с этим днём недели.
- «в пятницу/в среду» без уточнения → ПЕРВАЯ сверху строка с этим днём недели.
- Если день недели сегодня и пользователь сказал «в этот <тот же день>» — это значит на следующей неделе.
Не считай день недели по дате сам — бери из таблицы.

ОПРЕДЕЛЕНИЕ INTENT
- "create_task" — пользователь хочет добавить дело: «купи молоко», «не забыть позвонить Антону», «напомни написать Ивану», «надо забрать билет». Без жёсткой привязки времени.
- "create_event" — пользователь упоминает встречу с конкретным временем: «совещание в 4 завтра», «звонок с Антоном в пятницу 18:00», «встреча с Иваном в среду в 10».
- "chat" — всё остальное: вопросы, размышления, приветствия, просьбы рассказать что-то. Сюда же — если непонятно или сомнение.

ИЗВЛЕЧЕНИЕ
Если intent="create_task":
  task.text — короткая суть (без слов-триггеров «задача», «напомни», «надо»)
  task.due_date — YYYY-MM-DD (если не указано — сегодня)
  task.due_time — HH:MM или null
  Правила дат/времени:
  - «завтра» → today+1; «послезавтра» → today+2
  - «в понедельник/...» → ближайший такой день, если сегодня — следующая неделя
  - «утром» 09:00, «днём» 14:00, «вечером» 18:00
  - «в 10» → 10:00, «в 7 вечера» → 19:00

Если intent="create_event":
  event.title — название
  event.start_at_iso — ISO 8601 с offset зоны пользователя (например 2026-05-16T15:00:00+03:00)
  event.end_at_iso — если длительность не указана, +60 минут
  event.location — если упомянуто, иначе null

ОТВЕТ (reply)
Это короткое подтверждение или ответ в чате. Голос Пандитджи:
- Тёплый восточный друг, не учитель, не коуч. Тон Ходжи Насреддина у Соловьёва.
- Краткость: 1-2 предложения по умолчанию. Длинные — только если повод весомый.
- Можно обратиться «${userShortName}» или вообще без обращения.
- Иногда «ибо» вместо «потому что» (не в каждом сообщении — раз в три-пять).
- Иногда «не А, а Б» — мягкое противопоставление.
- «Не печалься / не тревожься» — только когда есть реальный повод волноваться.
- Десятичные через запятую: «12,5». Никаких эмодзи. Никаких восклицательных знаков. Никаких «achievement unlocked», streak-цифр как трофей, «работай над собой», «маленькие шаги ведут к большим». Никакого канцелярита («осуществить», «провести», «является», «данный»). Никаких калек с английского («обрати внимание», «дай себе время», «будь добр к себе»).
- Для задачи: «Записал. Завтра в 10:00.» / «Хорошо. Сегодня к вечеру.»
- Для встречи: «Запланировал на пятницу, 18:00.» / «Завтра в 4 — записал.»
- Для chat: отвечай как умный пожилой друг за чаем. Если не знаешь — скажи «Не знаю». Если вопрос про данные пользователя (биометрика, джапа, календарь), которых у тебя нет в этом сообщении — скажи «Открой главную, там видно».

ФОРМАТ ОТВЕТА
Только JSON, без markdown, без пояснений. Схема:
{"intent": "create_task" | "create_event" | "chat", "task"?: {...}, "event"?: {...}, "reply": "..."}`

  let resp: Response
  try {
    resp = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 700,
        system: sysPrompt,
        messages: [{ role: 'user', content: text }],
      }),
    })
  } catch (e) {
    console.error('claude fetch failed', e)
    return { intent: 'chat', reply: 'Не дотянулся до сети. Попробуй ещё раз.' }
  }

  if (!resp.ok) {
    console.error('claude error', resp.status, await resp.text())
    return { intent: 'chat', reply: 'Что-то у меня с головой. Попробуй ещё раз через минуту.' }
  }

  const data = await resp.json() as { content: Array<{ type: string; text: string }> }
  const block = data.content.find((b) => b.type === 'text')?.text ?? ''
  const cleaned = block.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()

  try {
    const parsed = JSON.parse(cleaned) as RoutedMessage
    if (!parsed.intent || !parsed.reply) throw new Error('missing fields')
    /* Sanity-check intent-specific fields. */
    if (parsed.intent === 'create_task') {
      if (!parsed.task?.text || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.task.due_date ?? '')) {
        console.warn('task fields incomplete, falling back to chat', parsed.task)
        return { intent: 'chat', reply: parsed.reply }
      }
      if (parsed.task.due_time && !/^\d{2}:\d{2}$/.test(parsed.task.due_time)) {
        parsed.task.due_time = null
      }
    }
    if (parsed.intent === 'create_event') {
      if (!parsed.event?.title || !parsed.event.start_at_iso || !parsed.event.end_at_iso) {
        console.warn('event fields incomplete, falling back to chat', parsed.event)
        return { intent: 'chat', reply: parsed.reply }
      }
    }
    return parsed
  } catch (e) {
    console.error('claude returned non-JSON', block, e)
    return { intent: 'chat', reply: 'Не разобрал. Попробуй сформулировать иначе.' }
  }
}

/* Ищем уже существующие события, пересекающиеся с новым.
 * Базовая overlap-проверка: existing.start < new.end AND existing.end > new.start. */
async function findCalendarConflicts(
  admin: SupabaseClient,
  userId: string,
  ev: { start_at_iso: string; end_at_iso: string },
): Promise<Array<{ id: string; title: string; start_at: string; end_at: string | null }>> {
  const { data, error } = await admin
    .from('calendar_events')
    .select('id, title, start_at, end_at')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .lt('start_at', ev.end_at_iso)
    .gt('end_at',   ev.start_at_iso)
    .order('start_at', { ascending: true })
  if (error) {
    console.warn('conflict check failed', error)
    return []
  }
  return data ?? []
}

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(iso))
}

const MONTHS_GEN_RU = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']

function fmtDateRu(iso: string, tz: string): string {
  const d = new Date(iso)
  const day = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, day: 'numeric' }).format(d))
  const monthIdx = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: 'numeric' }).format(d)) - 1
  return `${day} ${MONTHS_GEN_RU[monthIdx]}`
}

function buildConflictMessage(
  ev: { title: string; start_at_iso: string; end_at_iso: string },
  conflicts: Array<{ title: string; start_at: string; end_at: string | null }>,
  tz: string,
): string {
  const newDate = fmtDateRu(ev.start_at_iso, tz)
  const newRange = `${fmtTime(ev.start_at_iso, tz)}—${fmtTime(ev.end_at_iso, tz)}`
  const head = `«${ev.title}», ${newDate} ${newRange} — пересекается с:`
  const lines = conflicts.map(c => {
    const range = c.end_at
      ? `${fmtTime(c.start_at, tz)}—${fmtTime(c.end_at, tz)}`
      : fmtTime(c.start_at, tz)
    return `• ${c.title || '(без названия)'} — ${range}`
  }).join('\n')
  return `${head}\n${lines}\n\nЧто делать?`
}

async function sendTgWithInlineKeyboard(
  chatId: number,
  text: string,
  buttons: Array<{ text: string; callback_data: string }>,
): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: [buttons] },
    }),
  })
}

async function editTgMessage(chatId: number, messageId: number, text: string): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  await fetch(`${TG_API}/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  })
}

async function answerCallback(callbackQueryId: string): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  await fetch(`${TG_API}/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  })
}

function isCalendarCallback(data: string): boolean {
  return data === 'cal_force' || data === 'cal_cancel'
}

/* Зеркало созданного события в нашей calendar_events — чтобы PWA сразу видело. */
async function mirrorCalendarEvent(
  admin: SupabaseClient,
  userId: string,
  ev: { title: string; start_at_iso: string; end_at_iso: string; location?: string | null },
  googleId: string,
  tz: string,
): Promise<void> {
  await admin.from('calendar_events').upsert({
    user_id: userId,
    google_event_id: googleId,
    google_calendar_id: 'primary',
    title: ev.title,
    location_text: ev.location ?? null,
    start_at: ev.start_at_iso,
    end_at: ev.end_at_iso,
    is_all_day: false,
    timezone: tz,
    source: 'telegram_text',
    last_synced_at: new Date().toISOString(),
  }, { onConflict: 'google_event_id' })
}

async function handleCalendarCallback(
  admin: SupabaseClient,
  callbackQuery: any,
  userId: string,
): Promise<void> {
  await answerCallback(callbackQuery.id)
  const chatId: number = callbackQuery.message?.chat?.id
  const messageId: number = callbackQuery.message?.message_id
  if (!chatId || !messageId) return

  const { data: pending } = await admin
    .from('pending_calendar_event')
    .select('event_payload, tz')
    .eq('user_id', userId)
    .maybeSingle()
  if (!pending) {
    await editTgMessage(chatId, messageId, 'Время вышло — попробуй ещё раз.')
    return
  }

  if (callbackQuery.data === 'cal_cancel') {
    await admin.from('pending_calendar_event').delete().eq('user_id', userId)
    await editTgMessage(chatId, messageId, 'Отменил.')
    return
  }

  if (callbackQuery.data === 'cal_force') {
    await admin.from('pending_calendar_event').delete().eq('user_id', userId)
    const ev = pending.event_payload as { title: string; start_at_iso: string; end_at_iso: string; location?: string | null }
    const tz = pending.tz as string

    const accessToken = await googleAccessToken(admin, userId)
    if (!accessToken) {
      await editTgMessage(chatId, messageId, 'Google Calendar не подключён. Открой утренний экран и переподключи.')
      return
    }
    const created = await createGoogleEvent(accessToken, ev, tz)
    if (!created) {
      await editTgMessage(chatId, messageId, 'Не получилось положить в Google Calendar — посмотрю логи.')
      return
    }
    await mirrorCalendarEvent(admin, userId, ev, created.id, tz)
    await editTgMessage(chatId, messageId, `Записал: ${ev.title}, ${fmtDateRu(ev.start_at_iso, tz)} ${fmtTime(ev.start_at_iso, tz)}.`)
  }
}

async function createGoogleEvent(
  accessToken: string,
  ev: { title: string; start_at_iso: string; end_at_iso: string; location?: string | null },
  tz: string,
): Promise<{ id: string; htmlLink?: string } | null> {
  const resp = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: ev.title,
        location: ev.location ?? undefined,
        start: { dateTime: ev.start_at_iso, timeZone: tz },
        end:   { dateTime: ev.end_at_iso,   timeZone: tz },
      }),
    },
  )
  if (!resp.ok) {
    const body = await resp.text()
    console.error('google insert failed', resp.status, body)
    return null
  }
  const data = await resp.json()
  return { id: data.id, htmlLink: data.htmlLink }
}

Deno.serve(async (req) => {
  /* Проверяем secret_token, который Telegram прикладывает на каждый POST. */
  const secretHeader = req.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (secretHeader !== Deno.env.get('TELEGRAM_WEBHOOK_SECRET')) {
    return new Response('forbidden', { status: 403 })
  }

  let update: any
  try {
    update = await req.json()
  } catch {
    return ok()
  }

  /* Callback queries (inline-button taps) — джапа-диалог или calendar-конфликт. */
  if (update.callback_query) {
    const cbData = update.callback_query.data ?? ''
    if (isMeditationCallback(cbData) || isCalendarCallback(cbData)) {
      const admin = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )
      const tgUserId = update.callback_query.from?.id
      const { data: profile } = await admin
        .from('user_profile').select('id')
        .eq('telegram_chat_id', tgUserId).maybeSingle()
      if (profile) {
        if (isCalendarCallback(cbData)) {
          await handleCalendarCallback(admin, update.callback_query, profile.id as string)
        } else {
          await handleCallback(admin, update.callback_query, profile.id as string)
        }
      }
      return ok()
    }
  }

  const message = update.message ?? update.edited_message
  if (!message) return ok()

  const chatId: number | undefined = message.chat?.id
  if (!chatId) return ok()

  /* CSV document (Mind Monitor export) — джапа branch, handled inside meditation.ts. */
  if (message.document && isCsvDocument(message)) {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const { data: profile } = await admin
      .from('user_profile').select('id')
      .eq('telegram_chat_id', chatId).maybeSingle()
    if (!profile) {
      await sendTg(chatId, 'Не вижу тебя в системе. Открой in.adrian.ru/morning.html и жми «Привязать Telegram».')
      return ok()
    }
    /* Run in background so we return 200 immediately — parsing can take 5-10s. */
    const userId = profile.id as string
    // @ts-ignore — EdgeRuntime is provided by Supabase's Deno runtime.
    EdgeRuntime.waitUntil(handleCsvDocument(admin, chatId, userId, message.document))
    return ok()
  }

  /* Голос: пишем "печатает...", транскрибируем, пересказываем услышанное и дальше — как текст. */
  let text: string | undefined = message.text
  let transcript: string | null = null
  if (!text && message.voice?.file_id) {
    await sendTyping(chatId)
    transcript = await transcribeVoice(message.voice.file_id)
    if (!transcript) {
      await sendTg(chatId, 'Не разобрал голос. Попробуй ещё раз или напиши текстом.')
      return ok()
    }
    text = transcript
    await sendTg(chatId, `Услышал: «${transcript}»`)
  }
  if (!text) return ok()

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  /* /start <token>  — привязка аккаунта. */
  const startMatch = text.match(/^\/start(?:@\w+)?\s+(\S+)$/)
  if (startMatch) {
    const token = startMatch[1]
    const { data: profile } = await admin
      .from('user_profile')
      .select('id, short_name, telegram_chat_id')
      .eq('telegram_link_token', token)
      .maybeSingle()
    if (!profile) {
      await sendTg(chatId, 'Эта ссылка устарела. Открой утренний экран и сгенерируй новую.')
      return ok()
    }
    if (profile.telegram_chat_id && profile.telegram_chat_id !== chatId) {
      await sendTg(chatId, 'Уже привязан другой Telegram-аккаунт. Если это ошибка — напиши себе.')
      return ok()
    }
    await admin
      .from('user_profile')
      .update({ telegram_chat_id: chatId, telegram_link_token: null })
      .eq('id', profile.id)
    await sendTg(chatId, `Здравствуй, ${profile.short_name}. Бот привязан — можешь диктовать встречи прямо сюда.`)
    return ok()
  }

  /* /start без аргумента — подсказка. */
  if (/^\/start(?:@\w+)?\s*$/.test(text)) {
    await sendTg(chatId, 'Чтобы привязать аккаунт, открой in.adrian.ru/morning.html и жми «Привязать Telegram».')
    return ok()
  }

  /* Дальше — связан ли этот chat с пользователем? */
  const { data: profile } = await admin
    .from('user_profile')
    .select('id, short_name, current_location_id')
    .eq('telegram_chat_id', chatId)
    .maybeSingle()
  if (!profile) {
    await sendTg(chatId, 'Не вижу тебя в системе. Открой in.adrian.ru/morning.html и жми «Привязать Telegram».')
    return ok()
  }

  /* Джапа-команды и pending-text. */
  if (/^\/last(?:@\w+)?\s*$/.test(text)) {
    await handleLastCommand(admin, chatId, profile.id)
    return ok()
  }
  if (/^\/stats(?:@\w+)?\s*$/.test(text)) {
    await handleStatsCommand(chatId)
    return ok()
  }
  if (/^\/cancel(?:@\w+)?\s*$/.test(text)) {
    await admin.from('meditation_pending_session').delete().eq('user_id', profile.id)
    await sendTg(chatId, 'Незаконченный диалог удалён.')
    return ok()
  }
  /* Pending text input (circles "другое", location_custom). */
  if (await tryHandlePendingText(admin, chatId, profile.id, text)) {
    return ok()
  }

  /* Получаем зону пользователя (нужна Claude и Google API). */
  let tz = 'Europe/Moscow'
  if (profile.current_location_id) {
    const { data: loc } = await admin
      .from('locations').select('timezone')
      .eq('id', profile.current_location_id).maybeSingle()
    if (loc?.timezone) tz = loc.timezone
  }

  /* Один Claude-вызов решает всё: задача, встреча, или свободный чат. */
  await sendTyping(chatId)
  const routed = await routeMessage(text, tz, profile.short_name)

  if (routed.intent === 'create_task' && routed.task) {
    const { error } = await admin.from('tasks').insert({
      user_id: profile.id,
      text: routed.task.text,
      source: 'telegram',
      status: 'open',
      due_date: routed.task.due_date,
      due_time: routed.task.due_time,
      telegram_message_id: message.message_id ?? null,
    })
    if (error) {
      console.error('tasks insert failed', error)
      await sendTg(chatId, 'Не получилось сохранить задачу. Попробуй ещё раз.')
      return ok()
    }
    await sendTg(chatId, routed.reply)
    return ok()
  }

  if (routed.intent === 'create_event' && routed.event) {
    /* Перед созданием — проверяем пересечения с существующими. */
    const conflicts = await findCalendarConflicts(admin, profile.id, routed.event)
    if (conflicts.length > 0) {
      /* Сохраняем pending и спрашиваем подтверждение. */
      await admin.from('pending_calendar_event').upsert({
        user_id: profile.id,
        event_payload: routed.event,
        tz,
        conflict_count: conflicts.length,
      }, { onConflict: 'user_id' })
      await sendTgWithInlineKeyboard(
        chatId,
        buildConflictMessage(routed.event, conflicts, tz),
        [
          { text: 'Создать всё равно', callback_data: 'cal_force' },
          { text: 'Отменить',           callback_data: 'cal_cancel' },
        ],
      )
      return ok()
    }

    /* Конфликтов нет — создаём как обычно. */
    const accessToken = await googleAccessToken(admin, profile.id)
    if (!accessToken) {
      await sendTg(chatId, 'Google Calendar не подключён или сломан. Открой in.adrian.ru/morning.html и переподключи.')
      return ok()
    }
    const created = await createGoogleEvent(accessToken, routed.event, tz)
    if (!created) {
      await sendTg(chatId, 'Не получилось положить в Google Calendar — посмотрю логи позже.')
      return ok()
    }
    await mirrorCalendarEvent(admin, profile.id, routed.event, created.id, tz)
    await sendTg(chatId, routed.reply)
    return ok()
  }

  /* Свободный чат — Claude уже сформулировал ответ в нужном тоне. */
  await sendTg(chatId, routed.reply)
  return ok()
})
