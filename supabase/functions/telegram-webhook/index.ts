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
import { looksLikeTask, handleTaskFromMessage } from './tasks.ts'

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

interface ParsedEvent {
  intent: 'create_event' | 'unknown'
  confidence: number
  event?: { title: string; start_at_iso: string; end_at_iso: string; location?: string | null }
  reply: string
}

async function parseWithClaude(text: string, tz: string): Promise<ParsedEvent> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')!
  const now = new Date().toISOString()
  const sysPrompt = `Ты парсер сообщений в Telegram-бот личного ассистента (русскоязычный пользователь).
Текущий момент по UTC: ${now}
Часовая зона пользователя: ${tz}

Твоя задача — определить, описывает ли сообщение создание встречи в календаре. Если да — извлечь:
  - title (что за встреча)
  - start_at_iso (ISO 8601 с offset для зоны пользователя, например "2026-05-14T15:00:00+03:00")
  - end_at_iso (если длительность не указана — поставь +60 минут)
  - location (если упомянуто, иначе null)

Считай, что относительные даты ("завтра", "в пятницу", "через час") привязаны к текущему моменту в зоне пользователя.

Если сообщение не про создание встречи — intent="unknown".

Ответь СТРОГИМ JSON без markdown и без пояснений. Схема:
{"intent": "create_event" | "unknown", "confidence": 0.0-1.0, "event"?: {...}, "reply": "короткий ответ пользователю по-русски в спокойном тоне"}`

  const resp = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: sysPrompt,
      messages: [{ role: 'user', content: text }],
    }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    console.error('claude error', resp.status, body)
    return { intent: 'unknown', confidence: 0, reply: 'Что-то у меня с головой. Попробуй ещё раз через минуту.' }
  }

  const data = await resp.json() as { content: Array<{ type: string; text: string }> }
  const textBlock = data.content.find((b) => b.type === 'text')?.text ?? ''
  /* Убираем возможные ```json ... ``` обёртки. */
  const cleaned = textBlock.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try {
    return JSON.parse(cleaned) as ParsedEvent
  } catch {
    console.error('claude returned non-JSON', textBlock)
    return { intent: 'unknown', confidence: 0, reply: 'Не разобрал. Попробуй сформулировать иначе.' }
  }
}

async function createGoogleEvent(
  accessToken: string,
  ev: NonNullable<ParsedEvent['event']>,
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

  /* Callback queries (inline-button taps in the джапа dialog) come on their own field. */
  if (update.callback_query && isMeditationCallback(update.callback_query.data ?? '')) {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const tgUserId = update.callback_query.from?.id
    const { data: profile } = await admin
      .from('user_profile').select('id')
      .eq('telegram_chat_id', tgUserId).maybeSingle()
    if (profile) {
      await handleCallback(admin, update.callback_query, profile.id as string)
    }
    return ok()
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

  /* Task branch — runs BEFORE calendar event parsing. Prefix-triggered: only fires
   * when the message opens with «задача …», «поставь задачу …», «напомни …» etc.
   * Otherwise we fall through to the calendar event parser. */
  if (looksLikeTask(text)) {
    await sendTyping(chatId)
    await handleTaskFromMessage(admin, chatId, profile.id, tz, text, message.message_id)
    return ok()
  }

  const parsed = await parseWithClaude(text, tz)

  if (parsed.intent !== 'create_event' || !parsed.event) {
    await sendTg(chatId, parsed.reply || 'Пока умею только записывать встречи. Скажи когда и о чём.')
    return ok()
  }

  const accessToken = await googleAccessToken(admin, profile.id)
  if (!accessToken) {
    await sendTg(chatId, 'Google Calendar не подключён или сломан. Открой in.adrian.ru/morning.html и переподключи.')
    return ok()
  }

  const created = await createGoogleEvent(accessToken, parsed.event, tz)
  if (!created) {
    await sendTg(chatId, 'Не получилось положить в Google Calendar — посмотрю логи позже.')
    return ok()
  }

  /* Зеркалим в нашу БД. */
  await admin.from('calendar_events').upsert({
    user_id: profile.id,
    google_event_id: created.id,
    google_calendar_id: 'primary',
    title: parsed.event.title,
    location_text: parsed.event.location ?? null,
    start_at: parsed.event.start_at_iso,
    end_at: parsed.event.end_at_iso,
    is_all_day: false,
    timezone: tz,
    source: 'telegram_text',
    last_synced_at: new Date().toISOString(),
  }, { onConflict: 'google_event_id' })

  await sendTg(chatId, parsed.reply || `Записал: ${parsed.event.title}.`)
  return ok()
})
