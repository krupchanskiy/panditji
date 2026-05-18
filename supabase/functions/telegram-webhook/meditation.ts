/* Meditation (джапа) branch of telegram-webhook.
 *
 * Handles four kinds of update for this domain:
 *   - .csv document — Mind Monitor session export. Gzip → Storage → parse → start dialog.
 *   - callback_query with data "jp:..." — inline-button replies inside the post-upload dialog.
 *   - text "/last", "/stats" — read commands.
 *   - text in a pending step that expects free-form input (circles_other, location_custom).
 *
 * Webhook stays responsive: heavy work (download → parse → first message) runs inside
 * EdgeRuntime.waitUntil so the webhook returns 200 in <100ms.
 *
 * State lives in meditation_pending_session. One pending per user. */

import { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const TG_API = 'https://api.telegram.org'
const PENDING_TTL_HOURS = 48
const FRONTEND_BASE = Deno.env.get('PANDITJI_FRONTEND_URL') ?? 'https://in.adrian.ru'

type TgButton = { text: string; callback_data: string }
type TgKeyboard = { inline_keyboard: TgButton[][] }

/* ── Telegram helpers ──────────────────────────────────────────────────── */

async function tgSend(chatId: number, text: string, keyboard?: TgKeyboard): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: keyboard }),
  })
}

async function tgAnswerCallback(callbackQueryId: string, text?: string): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  await fetch(`${TG_API}/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  })
}

async function tgGetFilePath(fileId: string): Promise<string | null> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  const resp = await fetch(`${TG_API}/bot${token}/getFile?file_id=${fileId}`)
  if (!resp.ok) return null
  const data = await resp.json() as { ok: boolean; result?: { file_path: string } }
  return data.ok ? (data.result?.file_path ?? null) : null
}

async function tgDownloadFile(filePath: string): Promise<Uint8Array | null> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  const resp = await fetch(`${TG_API}/file/bot${token}/${filePath}`)
  if (!resp.ok) return null
  return new Uint8Array(await resp.arrayBuffer())
}

async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  /* Push bytes through a ReadableStream → CompressionStream → reassemble.
   * Direct Response(Uint8Array) trips Deno's strict ArrayBuffer typing. */
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(input)
      controller.close()
    },
  })
  // deno-lint-ignore no-explicit-any — Deno's strict typing tangles
  // ReadableStream<Uint8Array> with CompressionStream's BufferSource.
  const compressed = (source as any).pipeThrough(new CompressionStream('gzip')) as ReadableStream<Uint8Array>

  const chunks: Uint8Array[] = []
  const reader = compressed.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  const total = chunks.reduce((a, c) => a + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.byteLength }
  return out
}

/* ── document handler (CSV upload) ─────────────────────────────────────── */

export function isCsvDocument(message: { document?: { file_id: string; file_name?: string; mime_type?: string } }): boolean {
  const d = message.document
  if (!d) return false
  const name = (d.file_name ?? '').toLowerCase()
  return name.endsWith('.csv') || d.mime_type === 'text/csv' || name.startsWith('mindmonitor_')
}

export async function handleCsvDocument(
  supabase: SupabaseClient,
  chatId: number,
  userId: string,
  document: { file_id: string; file_name?: string },
): Promise<void> {
  /* 1. Check for existing pending. Brief 4.3: if fresh — ask. If expired — silently delete. */
  const pending = await loadPending(supabase, userId)
  if (pending && Date.parse(pending.expires_at) > Date.now()) {
    await tgSend(chatId,
      'Не успел закончить с предыдущей сессией. Что делаем?',
      kbRow([
        { text: 'Закончить старую', callback_data: 'jp:pending:keep' },
        { text: 'Удалить старую и начать новую', callback_data: `jp:pending:replace:${document.file_id}` },
      ]),
    )
    return
  }
  if (pending) {
    /* Expired — drop silently and continue. */
    await supabase.from('meditation_pending_session').delete().eq('user_id', userId)
  }

  await tgSend(chatId, 'Получил. Парсю — это займёт около минуты.')
  await processNewCsv(supabase, chatId, userId, document.file_id)
}

async function processNewCsv(
  supabase: SupabaseClient, chatId: number, userId: string, fileId: string,
): Promise<void> {
  /* Download + gzip + upload. */
  const filePath = await tgGetFilePath(fileId)
  if (!filePath) {
    await tgSend(chatId, 'Не получилось скачать файл из Telegram. Попробуй прислать ещё раз.')
    return
  }
  const csvBytes = await tgDownloadFile(filePath)
  if (!csvBytes) {
    await tgSend(chatId, 'Файл пустой или не открылся. Попробуй заново.')
    return
  }

  const gzBytes = await gzipBytes(csvBytes)
  const sessionId = crypto.randomUUID()
  const storagePath = `${userId}/${sessionId}.csv.gz`

  const { error: upErr } = await supabase.storage
    .from('meditation-csv')
    .upload(storagePath, gzBytes, { contentType: 'application/gzip', upsert: false })
  if (upErr) {
    console.error('storage upload failed:', upErr)
    await tgSend(chatId, 'Не получилось сохранить файл. Я записал в логи, посмотрим позже.')
    return
  }

  /* Parse. */
  const parseResp = await callEdge('parse-meditation-csv', {
    user_id: userId, session_id: sessionId, storage_path: storagePath,
  })
  if (!parseResp.ok) {
    /* Best-effort cleanup. */
    await supabase.storage.from('meditation-csv').remove([storagePath])
    await tgSend(chatId, formatParseError(parseResp.body))
    return
  }

  /* Open the dialog. */
  await supabase.from('meditation_pending_session').insert({
    user_id: userId,
    session_id: sessionId,
    step: 'kind',
    expires_at: new Date(Date.now() + PENDING_TTL_HOURS * 60 * 60 * 1000).toISOString(),
  })

  const summary = parseResp.body as { duration_min: number; signal_quality_pct: number }
  const intro = `Сессия ${summary.duration_min.toFixed(1)} мин, сигнал ${Math.round(summary.signal_quality_pct)}%.`
  await tgSend(chatId,
    `${intro}\n\nЧто это?`,
    kbRow([
      { text: 'Обычная джапа', callback_data: 'jp:kind:regular' },
      { text: 'Только посмотреть', callback_data: 'jp:kind:preview' },
    ]),
  )
}

function formatParseError(body: unknown): string {
  const e = body as { code?: string; message?: string }
  switch (e?.code) {
    case 'structure':     return 'Файл не похож на экспорт Mind Monitor — не нашёл нужных колонок.'
    case 'too_short':     return 'Сессия слишком короткая (меньше 5 минут).'
    case 'headband_off':  return 'Повязка была надета меньше половины времени — сохранять не стал.'
    default:              return `Не удалось разобрать CSV: ${e?.message ?? 'неизвестная ошибка'}.`
  }
}

/* ── callback handler ──────────────────────────────────────────────────── */

export function isMeditationCallback(data: string): boolean {
  return data.startsWith('jp:')
}

export async function handleCallback(
  supabase: SupabaseClient,
  callbackQuery: { id: string; from: { id: number }; data: string; message?: { chat: { id: number } } },
  userId: string,
): Promise<void> {
  const data = callbackQuery.data
  const chatId = callbackQuery.message?.chat.id
  if (!chatId) return
  await tgAnswerCallback(callbackQuery.id)

  /* "jp:pending:keep" / "jp:pending:replace:<file_id>" */
  if (data.startsWith('jp:pending:keep')) {
    await tgSend(chatId, 'Хорошо, заканчиваем со старой. Если забыл, на чём остановились — пришли /cancel и заново.')
    return
  }
  if (data.startsWith('jp:pending:replace:')) {
    const fileId = data.slice('jp:pending:replace:'.length)
    await supabase.from('meditation_pending_session').delete().eq('user_id', userId)
    await tgSend(chatId, 'Старую удалил. Парсю новую.')
    await processNewCsv(supabase, chatId, userId, fileId)
    return
  }

  const pending = await loadPending(supabase, userId)
  if (!pending) {
    await tgSend(chatId, 'Активный диалог не найден — пришли новый CSV.')
    return
  }

  /* Step-specific handlers. */
  if (data === 'jp:kind:regular' && pending.step === 'kind') {
    return await advanceFromKind(supabase, chatId, userId, pending.session_id, false)
  }
  if (data === 'jp:kind:preview' && pending.step === 'kind') {
    return await advanceFromKind(supabase, chatId, userId, pending.session_id, true)
  }
  if (data.startsWith('jp:circles:') && pending.step === 'circles') {
    const tail = data.slice('jp:circles:'.length)

    /* auto — взять число из меток Circle_Marker. */
    if (tail === 'auto') {
      const { data: sessRow } = await supabase
        .from('meditation_sessions')
        .select('circle_markers')
        .eq('id', pending.session_id)
        .maybeSingle()
      const markers = (sessRow?.circle_markers ?? null) as Array<{ count: number }> | null
      const n = markers && markers.length > 0
        ? markers.reduce((s, m) => s + (Number(m.count) || 0), 0)
        : 0
      if (n < 1) {
        /* Метки исчезли/невалидны — fallback на ручной выбор. */
        await askCirclesManual(chatId)
        return
      }
      return await advanceFromCircles(supabase, chatId, userId, pending.session_id, n)
    }

    /* manual — показать обычные кнопки выбора числа. Шаг остаётся 'circles'. */
    if (tail === 'manual') {
      await askCirclesManual(chatId)
      return
    }

    if (tail === 'other') {
      await setStep(supabase, userId, 'circles')   // stays; we just expect text
      await tgSend(chatId, 'Сколько кругов? Пришли число.')
      return
    }
    const n = parseInt(tail, 10)
    if (!Number.isFinite(n) || n < 1) {
      await tgSend(chatId, 'Не понял число. Попробуй ещё раз.')
      return
    }
    return await advanceFromCircles(supabase, chatId, userId, pending.session_id, n)
  }
  if (data.startsWith('jp:loc:') && pending.step === 'location') {
    const tail = data.slice('jp:loc:'.length)
    if (tail === 'other') {
      await setStep(supabase, userId, 'location_custom')
      await tgSend(chatId, 'Где сидел? Напиши коротко — например, «Майяпур, дом Раджи».')
      return
    }
    return await advanceFromLocation(supabase, chatId, userId, pending.session_id, tail)
  }
  if (data.startsWith('jp:dist:') && pending.step === 'distracted') {
    const value = data.slice('jp:dist:'.length)
    if (!['никто', 'немного', 'сильно'].includes(value)) {
      await tgSend(chatId, 'Не понял ответ.')
      return
    }
    return await advanceFromDistracted(supabase, chatId, userId, pending.session_id, value)
  }
  if (data.startsWith('jp:rate:') && pending.step === 'rating') {
    const n = parseInt(data.slice('jp:rate:'.length), 10)
    if (!Number.isFinite(n) || n < 1 || n > 5) {
      await tgSend(chatId, 'Оценка от 1 до 5.')
      return
    }
    return await finalizeDialog(supabase, chatId, userId, pending.session_id, n)
  }
}

/* ── text in pending flow (circles_other, location_custom) ─────────────── */

export async function tryHandlePendingText(
  supabase: SupabaseClient, chatId: number, userId: string, text: string,
): Promise<boolean> {
  const pending = await loadPending(supabase, userId)
  if (!pending) return false

  /* "circles" step is on the keyboard normally, but if the user pressed "другое"
   * we keep the step and wait for a number in text. */
  if (pending.step === 'circles' && /^\d+$/.test(text.trim())) {
    const n = parseInt(text.trim(), 10)
    if (n < 1 || n > 200) {
      await tgSend(chatId, 'Число кругов между 1 и 200.')
      return true
    }
    await advanceFromCircles(supabase, chatId, userId, pending.session_id, n)
    return true
  }

  if (pending.step === 'location_custom') {
    const slug = makeLocationSlug(text)
    const { data: existing } = await supabase
      .from('locations').select('id').eq('user_id', userId).eq('key', slug).maybeSingle()
    let locationId = existing?.id as string | undefined
    if (!locationId) {
      const { data: inserted, error: insErr } = await supabase
        .from('locations')
        .insert({ user_id: userId, key: slug, name: text.trim(), country: '', lat: 0, lon: 0, timezone: 'Europe/Moscow' })
        .select('id').single()
      if (insErr) {
        console.error('location insert failed:', insErr)
        await tgSend(chatId, 'Не удалось сохранить локацию. Выбери из списка ещё раз.')
        await setStep(supabase, userId, 'location')
        return true
      }
      locationId = inserted.id
    }
    await advanceFromLocation(supabase, chatId, userId, pending.session_id, locationId!)
    return true
  }

  return false
}

/* ── steps ─────────────────────────────────────────────────────────────── */

async function advanceFromKind(
  supabase: SupabaseClient, chatId: number, userId: string, sessionId: string, preview: boolean,
): Promise<void> {
  if (preview) {
    await supabase.from('meditation_sessions').update({
      session_kind: 'preview',
      excluded_from_stats: true,
      excluded_reason: 'preview',
      excluded_at: new Date().toISOString(),
    }).eq('id', sessionId)
  }
  await setStep(supabase, userId, 'circles')

  /* Если в файле были метки Circle_Marker (внешний инструмент) — сразу
   * предлагаем подтвердить число из таймингов вместо обычного выбора. */
  const { data: sessRow } = await supabase
    .from('meditation_sessions')
    .select('circle_markers')
    .eq('id', sessionId)
    .maybeSingle()
  const markers = (sessRow?.circle_markers ?? null) as Array<{ count: number }> | null
  const sumCount = markers && markers.length > 0
    ? markers.reduce((s, m) => s + (Number(m.count) || 0), 0)
    : 0

  if (sumCount >= 1) {
    await tgSend(chatId, `В записи отмечено ${sumCount} кругов по таймингам. Верно?`,
      kbRow([
        { text: 'Да', callback_data: 'jp:circles:auto' },
        { text: 'Указать вручную', callback_data: 'jp:circles:manual' },
      ]))
    return
  }

  await askCirclesManual(chatId)
}

/* Существующий выбор числа кнопками — выделен в отдельную функцию,
 * чтобы переиспользоваться при ручном fallback. */
async function askCirclesManual(chatId: number): Promise<void> {
  await tgSend(chatId, 'Сколько кругов было?',
    kbRows([
      [{ text: '8', callback_data: 'jp:circles:8' },
       { text: '12', callback_data: 'jp:circles:12' },
       { text: '16', callback_data: 'jp:circles:16' },
       { text: '24', callback_data: 'jp:circles:24' }],
      [{ text: 'другое', callback_data: 'jp:circles:other' }],
    ]))
}

async function advanceFromCircles(
  supabase: SupabaseClient, chatId: number, userId: string, sessionId: string, n: number,
): Promise<void> {
  /* Run compute synchronously — bot needs the brief report fields. Heavy step is the parse;
   * compute on a parsed session is sub-second. */
  const computeResp = await callEdge('compute-meditation-circles', {
    user_id: userId, session_id: sessionId, circles: n,
  })
  if (!computeResp.ok) {
    console.error('compute failed:', computeResp.body)
    await tgSend(chatId, 'Не получилось разбить на круги. Логи посмотрю позже — пока пришли /cancel.')
    return
  }
  await setStep(supabase, userId, 'location')

  /* Build location buttons: user's locations, up to 5 + "другое". */
  const { data: locs } = await supabase
    .from('locations')
    .select('id, name, is_primary')
    .eq('user_id', userId)
    .order('is_primary', { ascending: false })
    .limit(5)
  const buttons: TgButton[][] = []
  for (const l of (locs ?? [])) {
    buttons.push([{ text: l.name as string, callback_data: `jp:loc:${l.id}` }])
  }
  buttons.push([{ text: 'другое место', callback_data: 'jp:loc:other' }])
  await tgSend(chatId, 'Где сидел?', { inline_keyboard: buttons })
}

async function advanceFromLocation(
  supabase: SupabaseClient, chatId: number, userId: string, sessionId: string, locationId: string,
): Promise<void> {
  await supabase.from('meditation_sessions')
    .update({ location_id: locationId })
    .eq('id', sessionId)
  await setStep(supabase, userId, 'distracted')
  await tgSend(chatId, 'Отвлекали во время джапы?',
    kbRow([
      { text: 'Никто', callback_data: 'jp:dist:никто' },
      { text: 'Немного', callback_data: 'jp:dist:немного' },
      { text: 'Сильно', callback_data: 'jp:dist:сильно' },
    ]))
}

async function advanceFromDistracted(
  supabase: SupabaseClient, chatId: number, userId: string, sessionId: string, value: string,
): Promise<void> {
  await supabase.from('meditation_sessions')
    .update({ distracted: value })
    .eq('id', sessionId)
  await setStep(supabase, userId, 'rating')
  await tgSend(chatId, 'Как сам ощутил эту джапу? (1 = очень плохо, 5 = очень хорошо. Это твоё ощущение, отдельно от данных.)',
    kbRow([
      { text: '1', callback_data: 'jp:rate:1' },
      { text: '2', callback_data: 'jp:rate:2' },
      { text: '3', callback_data: 'jp:rate:3' },
      { text: '4', callback_data: 'jp:rate:4' },
      { text: '5', callback_data: 'jp:rate:5' },
    ]))
}

async function finalizeDialog(
  supabase: SupabaseClient, chatId: number, userId: string, sessionId: string, rating: number,
): Promise<void> {
  await supabase.from('meditation_sessions')
    .update({ self_rating: rating })
    .eq('id', sessionId)
  await supabase.from('meditation_pending_session')
    .delete().eq('user_id', userId)

  /* Load the freshly-updated session for the brief report. */
  const report = await buildBriefReport(supabase, sessionId)
  await tgSend(chatId, report, kbRow([
    { text: '→ Подробный отчёт', callback_data: 'jp:open:' + sessionId },
  ]))
  /* The frontend link as a text fallback — Telegram doesn't let us put external
   * URLs into callback_data, but we can place one as a plain link in a follow-up. */
  await tgSend(chatId, `<a href="${FRONTEND_BASE}/meditation/sessions.html?id=${sessionId}">Открыть на сайте</a>`)
}

/* ── /last, /stats ──────────────────────────────────────────────────────── */

export async function handleLastCommand(
  supabase: SupabaseClient, chatId: number, userId: string,
): Promise<void> {
  const { data: last } = await supabase
    .from('meditation_sessions')
    .select('id')
    .eq('user_id', userId)
    .not('circles', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!last) {
    await tgSend(chatId, 'Завершённых сессий пока нет.')
    return
  }
  const report = await buildBriefReport(supabase, last.id as string)
  await tgSend(chatId, report)
  await tgSend(chatId, `<a href="${FRONTEND_BASE}/meditation/sessions.html?id=${last.id}">Открыть на сайте</a>`)
}

export async function handleStatsCommand(chatId: number): Promise<void> {
  await tgSend(chatId, `Статистика — <a href="${FRONTEND_BASE}/meditation/trends.html">${FRONTEND_BASE}/meditation/trends.html</a>`)
}

/* ── brief report builder ──────────────────────────────────────────────── */

async function buildBriefReport(supabase: SupabaseClient, sessionId: string): Promise<string> {
  const { data: s } = await supabase
    .from('meditation_sessions')
    .select(`
      id, started_at, duration_sec, circles, pace_min_per_circle,
      session_kind, signal_quality_pct,
      deepening_pct, deepening_reliable, ab_index_median, longest_calm_sec,
      signal_shift_at_sec, signal_shift_severity,
      interpretations
    `)
    .eq('id', sessionId)
    .single()
  if (!s) return 'Не нашёл сессию.'

  const dt = new Date(s.started_at)
  const dateLine = `Сессия ${dt.getUTCDate()} ${monthRu(dt.getUTCMonth())}, ${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}`
  const previewTag = s.session_kind === 'preview' ? ' · только посмотреть' : ''

  const lines: string[] = [`${dateLine}${previewTag}`]
  lines.push(`${(s.duration_sec / 60).toFixed(1)} мин · ${s.circles} кругов · ${s.pace_min_per_circle} мин/круг`)
  lines.push('')

  /* Headband shift takes priority over normal metrics. */
  if (s.signal_shift_severity) {
    const minute = Math.floor((s.signal_shift_at_sec ?? 0) / 60)
    lines.push(`⚠ На ${minute}-й минуте — резкая смена сигнала.`)
    lines.push('Скорее всего, повязка сдвинулась. Метрики углубления недостоверны.')
    lines.push('')
    lines.push(`Стабильность A/B (до ${minute}-й мин): ${s.ab_index_median}`)
  } else {
    if (s.deepening_reliable && s.deepening_pct !== null) {
      lines.push(`Углубление Theta: ${formatDelta(s.deepening_pct)}%`)
    }
    lines.push(`Стабильность A/B: ${s.ab_index_median}`)
    if (s.longest_calm_sec) {
      lines.push(`Самый длинный calm: ${formatMinSec(s.longest_calm_sec)}`)
    }
  }

  lines.push('')
  lines.push(`Сигнал: ${Math.round(s.signal_quality_pct)}%${s.signal_quality_pct >= 90 ? ' ✓' : ''}`)

  const main = s.interpretations?.main as string | undefined
  if (main) {
    lines.push('')
    lines.push(main)
  }

  if (s.session_kind === 'preview') {
    lines.push('')
    lines.push('<i>Эта сессия не учитывается в статистике.</i>')
  }

  return lines.join('\n')
}

/* ── helpers ───────────────────────────────────────────────────────────── */

async function loadPending(supabase: SupabaseClient, userId: string): Promise<
  { session_id: string; step: string; expires_at: string } | null
> {
  const { data } = await supabase
    .from('meditation_pending_session')
    .select('session_id, step, expires_at')
    .eq('user_id', userId)
    .maybeSingle()
  return data as { session_id: string; step: string; expires_at: string } | null
}

async function setStep(supabase: SupabaseClient, userId: string, step: string): Promise<void> {
  await supabase.from('meditation_pending_session')
    .update({ step, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
}

async function callEdge(
  name: string, body: unknown,
): Promise<{ ok: boolean; body: unknown; status: number }> {
  const url = Deno.env.get('SUPABASE_URL')!
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const resp = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })
  const text = await resp.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* leave as text */ }
  return { ok: resp.ok, body: parsed, status: resp.status }
}

function kbRow(buttons: TgButton[]): TgKeyboard {
  return { inline_keyboard: [buttons] }
}
function kbRows(rows: TgButton[][]): TgKeyboard {
  return { inline_keyboard: rows }
}

function makeLocationSlug(text: string): string {
  const base = text.trim().toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9 _-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 40)
  return base || `custom_${Date.now()}`
}

function pad2(n: number): string { return String(n).padStart(2, '0') }

function monthRu(m: number): string {
  return ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][m]
}

function formatDelta(v: number): string {
  return (v >= 0 ? '+' : '') + Math.round(v)
}

function formatMinSec(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s === 0 ? `${m} мин` : `${m} мин ${s} сек`
}
