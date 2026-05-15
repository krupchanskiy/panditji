/* Task branch of telegram-webhook.
 *
 * Routes text (and voice → STT) messages that look like a task request:
 *   - Prefix triggers: "задача ...", "поставь задачу ...", "добавь задачу ...",
 *     "напомни ...", "не забыть ...", "не забудь ..." (case-insensitive,
 *     optional greeting like "пандитджи, " is stripped first).
 *
 * Pipeline:
 *   1. looksLikeTask() filters at the cheap prefix level — no LLM call if no trigger.
 *   2. Claude parses {text, due_date, due_time} relative to user's TZ.
 *   3. INSERT into tasks (Realtime fans it out to PWA).
 *   4. Reply to Telegram with a calm confirmation.
 *
 * We do NOT use the LLM to decide "is this a task or not" — the prefix decides that.
 * The LLM only extracts the structured fields. */

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const TG_API = 'https://api.telegram.org'
const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-5'

const WEEKDAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']
const MONTHS_GEN_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

interface ParsedTask {
  text: string
  due_date: string         // YYYY-MM-DD
  due_time: string | null  // HH:MM or null
}

/* ── Trigger detection ─────────────────────────────────────────────────── */

const GREETING_RE = /^(пандитджи|пандит-джи|пандит джи|пандитджи джи)[,\s]+/iu

/* Word boundary in JS regex is ASCII-only; \b doesn't trigger between Cyrillic letters
 * and surrounding chars. We use a lookahead for end-of-string or non-letter instead. */
const END = '(?=$|[^\\p{L}])'

const TRIGGER_PATTERNS: RegExp[] = [
  new RegExp(`^задач[ау]${END}`,                       'iu'),
  new RegExp(`^поставь(?:\\s+мне)?\\s+задачу${END}`,   'iu'),
  new RegExp(`^добавь(?:\\s+мне)?\\s+задачу${END}`,    'iu'),
  new RegExp(`^запиши(?:\\s+мне)?\\s+задачу${END}`,    'iu'),
  new RegExp(`^напомни${END}`,                         'iu'),
  new RegExp(`^не\\s+(?:забыть|забудь)${END}`,         'iu'),
  /^надо\s+/iu,
]

function stripGreeting(text: string): string {
  return text.replace(GREETING_RE, '').trimStart()
}

export function looksLikeTask(text: string): boolean {
  const stripped = stripGreeting(text.trim())
  if (!stripped) return false
  return TRIGGER_PATTERNS.some((re) => re.test(stripped))
}

/* ── Local-date helpers (in user's TZ) ─────────────────────────────────── */

function localDate(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/* Parse YYYY-MM-DD as a calendar date (no TZ). For pure date math. */
function parseDateOnly(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m, d }
}

/* Difference in days between two YYYY-MM-DD dates (b - a). Ignores TZ. */
function dayDiff(a: string, b: string): number {
  const da = parseDateOnly(a)
  const db = parseDateOnly(b)
  const ms = Date.UTC(db.y, db.m - 1, db.d) - Date.UTC(da.y, da.m - 1, da.d)
  return Math.round(ms / 86400000)
}

/* Day-of-week (0=Sun..6=Sat) for a YYYY-MM-DD treated as a plain calendar date. */
function dowOf(iso: string): number {
  const { y, m, d } = parseDateOnly(iso)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/* Format due-date as a calm Russian phrase relative to today.
 *   today        → "Сегодня"
 *   today+1      → "Завтра"
 *   2..6 days    → "Понедельник" (weekday, capitalized)
 *   else         → "17 мая" */
function formatDueDate(today: string, dueDate: string): string {
  const diff = dayDiff(today, dueDate)
  if (diff === 0) return 'Сегодня'
  if (diff === 1) return 'Завтра'
  if (diff >= 2 && diff <= 6) {
    const wd = WEEKDAYS_RU[dowOf(dueDate)]
    return wd.charAt(0).toUpperCase() + wd.slice(1)
  }
  const { m, d } = parseDateOnly(dueDate)
  return `${d} ${MONTHS_GEN_RU[m - 1]}`
}

function formatConfirmation(today: string, task: ParsedTask): string {
  const datePart = formatDueDate(today, task.due_date)
  const tail = task.due_time ? `${datePart}, ${task.due_time}` : datePart
  return `Задача: ${task.text}\n${tail}`
}

/* ── LLM parser ────────────────────────────────────────────────────────── */

async function parseTaskWithClaude(text: string, today: string, tz: string): Promise<ParsedTask | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set')
    return null
  }

  const sysPrompt = `Ты извлекаешь из голосового или текстового сообщения структурированную задачу.

На вход — текст сообщения пользователя (после распознавания речи).
На выход — строгий JSON без markdown, без пояснений:

{
  "text": "краткая суть задачи без слов-триггеров",
  "due_date": "YYYY-MM-DD",
  "due_time": "HH:MM" | null
}

Правила:
- Если дата не указана — ставь сегодняшнюю дату пользователя.
- "завтра" → today + 1 день
- "послезавтра" → today + 2 дня
- "в понедельник/вторник/..." → ближайший такой день недели; если сегодня уже этот день — следующая неделя
- "через неделю" → today + 7 дней
- "к концу недели" → ближайшая пятница
- "в пятницу к вечеру" → ближайшая пятница, due_time="18:00"
- "утром" → 09:00, "днём" → 14:00, "вечером" → 18:00, "ночью" → 22:00
- "в 10" / "в 10 утра" → 10:00; "в 3 дня" → 15:00; "в 7 вечера" → 19:00
- Слова-триггеры ("задача", "поставь задачу", "напомни", "добавь задачу", "не забыть", "не забудь", "надо") в text НЕ включать.
- Если в сообщении нет понятного содержимого задачи — text="" (вызывающий код обработает).
- Никаких комментариев, объяснений, только JSON.

Контекст:
- Сегодня (локальная дата пользователя): ${today}
- Часовой пояс пользователя: ${tz}`

  const resp = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 256,
      system: sysPrompt,
      messages: [{ role: 'user', content: text }],
    }),
  })

  if (!resp.ok) {
    console.error('claude task-parser error', resp.status, await resp.text())
    return null
  }

  const data = await resp.json() as { content: Array<{ type: string; text: string }> }
  const block = data.content.find((b) => b.type === 'text')?.text ?? ''
  const cleaned = block.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()

  try {
    const parsed = JSON.parse(cleaned) as ParsedTask
    /* Basic sanity. due_date must be YYYY-MM-DD. */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.due_date)) {
      console.error('claude returned bad due_date', parsed.due_date)
      return null
    }
    if (parsed.due_time && !/^\d{2}:\d{2}$/.test(parsed.due_time)) {
      console.error('claude returned bad due_time', parsed.due_time)
      parsed.due_time = null
    }
    return parsed
  } catch {
    console.error('claude returned non-JSON for task', block)
    return null
  }
}

/* ── Telegram helper (replies stay calm and tone-neutral) ──────────────── */

async function tgReply(chatId: number, text: string): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
}

/* ── Public entry — called from index.ts when looksLikeTask() is true ──── */

export async function handleTaskFromMessage(
  admin: SupabaseClient,
  chatId: number,
  userId: string,
  tz: string,
  text: string,
  telegramMessageId: number | undefined,
): Promise<void> {
  const today = localDate(tz)
  const parsed = await parseTaskWithClaude(text, today, tz)

  if (!parsed) {
    await tgReply(chatId, 'Не получилось разобрать. Попробуй ещё раз.')
    return
  }

  const cleanText = (parsed.text ?? '').trim()
  if (!cleanText) {
    await tgReply(chatId, 'Не понял, что за задача. Скажи ещё раз.')
    return
  }

  const { data: inserted, error } = await admin.from('tasks').insert({
    user_id: userId,
    text: cleanText,
    source: 'telegram',
    status: 'open',
    due_date: parsed.due_date,
    due_time: parsed.due_time,
    telegram_message_id: telegramMessageId ?? null,
  }).select('id').single()

  if (error || !inserted) {
    console.error('tasks insert failed', error)
    await tgReply(chatId, 'Не получилось сохранить задачу. Попробуй ещё раз.')
    return
  }

  await tgReply(chatId, formatConfirmation(today, {
    text: cleanText,
    due_date: parsed.due_date,
    due_time: parsed.due_time,
  }))
}
