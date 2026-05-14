/* Edge Function: metric-detail
 * Возвращает данные и клиническое объяснение для одного из трёх показателей Whoop:
 *   ?type=recovery | sleep | hrv
 * Объяснение генерирует Claude в нейтральном профессиональном тоне (НЕ голос Пандитджи),
 * кэшируется в messages с kind='metric_<type>'. */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-5'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function localDate(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

const CLINICAL_VOICE = `
Ты — точный объяснитель биометрических данных на русском языке. Тон — нейтральный, профессиональный, как у внимательного врача-консультанта.

Запрещено:
— Обращения к пользователю по имени, восточный флёр, поэтика, метафоры.
— Эмодзи, иконки.
— Маркетинговая лексика ("отлично", "потрясающе", "ваш организм просит").
— Шаблонные оговорки ("важно понимать", "стоит отметить", "обратите внимание").
— Markdown, JSON, преамбулы вроде "Вот объяснение:".

Содержание: 2-4 предложения. Используй конкретные числа из контекста. Если данных не хватает — не выдумывай и не интерполируй.

Форматирование: выделяй **жирным через двойные звёздочки** ключевые цифры и физиологические термины — 2-4 выделения на параграф, не больше, не подряд. Примеры: «**56 %** находится в средней зоне», «активность **парасимпатической нервной системы**», «доля **глубокого сна 19 %**». Это нужно чтобы цифры легче выхватывались взглядом. Не выделяй каждое число — только опорные. НИКАКОГО другого markdown — никаких #, _, [], только **...**.

Что объясни (когда применимо):
— Где сегодняшнее число относительно нормы и относительно личной недели.
— Главный вклад в показатель: какой компонент тянет вверх/вниз.
— Что это значит физиологически, простыми словами.
— Краткая динамика за 7-30 дней.

Ответ — только готовый текст параграфом.
`.trim()

interface RecoveryRow {
  date: string
  recovery_score: number
  hrv_rmssd_ms: number | null
  resting_heart_rate: number | null
  respiratory_rate: number | null
  spo2_percentage: number | null
  skin_temp_celsius: number | null
  sleep_id: string | null
}

interface SleepRow {
  start_at: string
  end_at: string
  duration_seconds: number
  sleep_efficiency: number | null
  sleep_performance: number | null
  light_sleep_seconds: number | null
  deep_sleep_seconds: number | null
  rem_sleep_seconds: number | null
  awake_seconds: number | null
  disturbance_count: number | null
  respiratory_rate: number | null
  raw_response: Record<string, any>
}

function n(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

function range(nums: number[]): { avg: number; min: number; max: number; count: number } {
  const xs = nums.filter((x) => typeof x === 'number' && Number.isFinite(x))
  if (xs.length === 0) return { avg: 0, min: 0, max: 0, count: 0 }
  const min = Math.min(...xs)
  const max = Math.max(...xs)
  const avg = xs.reduce((a, b) => a + b, 0) / xs.length
  return { avg: Math.round(avg * 10) / 10, min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10, count: xs.length }
}

async function callClaude(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return null
  const resp = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })
  if (!resp.ok) {
    console.error('claude error', resp.status, await resp.text())
    return null
  }
  const data = await resp.json() as { content: Array<{ type: string; text: string }> }
  return data.content.find((b) => b.type === 'text')?.text?.trim() ?? null
}

async function buildRecovery(db: any, userId: string, ageYears: number) {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
  const { data: recoveries } = await db
    .from('whoop_recovery')
    .select('date, recovery_score, hrv_rmssd_ms, resting_heart_rate, respiratory_rate, spo2_percentage, skin_temp_celsius, sleep_id')
    .gte('date', since)
    .order('date', { ascending: false }) as { data: RecoveryRow[] | null }

  if (!recoveries || recoveries.length === 0) return null
  const today = recoveries[0]
  const last7 = recoveries.slice(0, 7)
  const last30 = recoveries.slice(0, 30)

  const scoreTrend7 = range(last7.map((r) => r.recovery_score))
  const hrvTrend7  = range(last7.map((r) => n(r.hrv_rmssd_ms) ?? NaN).filter((x) => !isNaN(x)))
  const hrvTrend30 = range(last30.map((r) => n(r.hrv_rmssd_ms) ?? NaN).filter((x) => !isNaN(x)))
  const rhrTrend7  = range(last7.map((r) => r.resting_heart_rate ?? NaN).filter((x) => !isNaN(x)))

  const band = today.recovery_score >= 67 ? 'high' : today.recovery_score >= 34 ? 'mid' : 'low'

  const today_data = {
    score: today.recovery_score,
    band,
    hrv_ms: n(today.hrv_rmssd_ms),
    resting_hr: today.resting_heart_rate,
    respiratory_rate: n(today.respiratory_rate),
    spo2_pct: n(today.spo2_percentage),
    skin_temp_c: n(today.skin_temp_celsius),
  }
  const trends = {
    recovery_7d: scoreTrend7,
    hrv_7d: hrvTrend7,
    hrv_30d: hrvTrend30,
    rhr_7d: rhrTrend7,
  }

  const claudePrompt = `Возраст пользователя: ${ageYears} лет.
Сегодняшние данные Whoop Recovery:
${JSON.stringify(today_data, null, 2)}

Тренды:
${JSON.stringify(trends, null, 2)}

Объясни сегодняшний показатель и его компоненты. Учти что Whoop bands: 0-33 низкая, 34-66 средняя, 67-100 высокая.`

  const explanation = await callClaude(CLINICAL_VOICE, claudePrompt)
  return { type: 'recovery', today: today_data, trends, explanation }
}

async function buildSleep(db: any, userId: string, ageYears: number, tz: string) {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data: sleeps } = await db
    .from('whoop_sleeps')
    .select('start_at, end_at, duration_seconds, sleep_efficiency, sleep_performance, light_sleep_seconds, deep_sleep_seconds, rem_sleep_seconds, awake_seconds, disturbance_count, respiratory_rate, raw_response')
    .gte('start_at', since)
    .order('start_at', { ascending: false }) as { data: SleepRow[] | null }

  if (!sleeps || sleeps.length === 0) return null
  const today = sleeps[0]
  const last7 = sleeps.slice(0, 7)

  const stage = today.raw_response?.score?.stage_summary ?? {}
  const score = today.raw_response?.score ?? {}
  const needed = score.sleep_needed ?? {}

  const inBedSeconds = stage.total_in_bed_time_milli ? Math.round(stage.total_in_bed_time_milli / 1000) : null
  const fmtTime = (iso: string) => new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso))

  const today_data = {
    bedtime_local: fmtTime(today.start_at),
    wake_local: fmtTime(today.end_at),
    in_bed_seconds: inBedSeconds,
    asleep_seconds: today.duration_seconds,
    light_seconds: today.light_sleep_seconds,
    deep_seconds: today.deep_sleep_seconds,
    rem_seconds: today.rem_sleep_seconds,
    awake_seconds: today.awake_seconds,
    sleep_cycle_count: stage.sleep_cycle_count ?? null,
    disturbance_count: today.disturbance_count,
    sleep_efficiency_pct: n(today.sleep_efficiency),
    sleep_performance_pct: n(today.sleep_performance),
    sleep_consistency_pct: n(score.sleep_consistency_percentage),
    respiratory_rate: n(today.respiratory_rate),
    sleep_needed_seconds: needed.need_from_sleep_debt_milli && needed.baseline_milli
      ? Math.round((needed.baseline_milli + needed.need_from_sleep_debt_milli + (needed.need_from_recent_strain_milli ?? 0) + (needed.need_from_recent_nap_milli ?? 0)) / 1000)
      : null,
    sleep_debt_seconds: needed.need_from_sleep_debt_milli ? Math.round(needed.need_from_sleep_debt_milli / 1000) : null,
  }

  const trends = {
    asleep_hours_7d: range(last7.map((s) => s.duration_seconds / 3600)),
    efficiency_7d: range(last7.map((s) => n(s.sleep_efficiency) ?? NaN).filter((x) => !isNaN(x))),
    performance_7d: range(last7.map((s) => n(s.sleep_performance) ?? NaN).filter((x) => !isNaN(x))),
  }

  const claudePrompt = `Возраст пользователя: ${ageYears} лет.
Сегодняшний сон по Whoop:
${JSON.stringify(today_data, null, 2)}

Тренды за 7 дней:
${JSON.stringify(trends, null, 2)}

Объясни архитектуру ночи: достаточно ли времени сна, как соотношение стадий (light/deep/rem) для возраста, нормальна ли эффективность.`

  const explanation = await callClaude(CLINICAL_VOICE, claudePrompt)
  return { type: 'sleep', today: today_data, trends, explanation }
}

async function buildHrv(db: any, userId: string, ageYears: number) {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
  const { data: recoveries } = await db
    .from('whoop_recovery')
    .select('date, hrv_rmssd_ms')
    .gte('date', since)
    .order('date', { ascending: false }) as { data: Array<{ date: string; hrv_rmssd_ms: number | null }> | null }

  if (!recoveries || recoveries.length === 0) return null
  const todayHrv = n(recoveries[0].hrv_rmssd_ms)
  const valid = recoveries.map((r) => n(r.hrv_rmssd_ms)).filter((x): x is number => x !== null)
  const last7 = valid.slice(0, 7)
  const last14 = valid.slice(0, 14)
  const last30 = valid

  const today_data = { hrv_ms: todayHrv, date: recoveries[0].date }
  const trends = {
    hrv_7d: range(last7),
    hrv_14d: range(last14),
    hrv_30d: range(last30),
  }

  const claudePrompt = `Возраст пользователя: ${ageYears} лет.
Сегодняшний HRV RMSSD: ${todayHrv} мс.
Тренды:
${JSON.stringify(trends, null, 2)}

Типичные диапазоны RMSSD у взрослых мужчин снижаются с возрастом: 30-40 лет ~ 25-50 мс, 40-50 лет ~ 20-45 мс, 50+ ~ 15-40 мс (медиана). Объясни сегодняшнее значение, его место в недельном и месячном диапазоне, и что HRV отражает физиологически (баланс симпатики/парасимпатики, восстановление, готовность).`

  const explanation = await callClaude(CLINICAL_VOICE, claudePrompt)
  return { type: 'hrv', today: today_data, trends, explanation }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'missing authorization' }, 401)

  const url = new URL(req.url)
  const type = url.searchParams.get('type')
  if (!type || !['recovery', 'sleep', 'hrv'].includes(type)) {
    return json({ error: 'type must be recovery|sleep|hrv' }, 400)
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const { data: { user }, error: userErr } = await db.auth.getUser()
  if (userErr || !user) return json({ error: 'invalid token' }, 401)

  const { data: profile } = await db
    .from('user_profile')
    .select('birth_date, current_location_id')
    .eq('id', user.id)
    .single()
  if (!profile) return json({ error: 'no profile' }, 404)

  const ageYears = profile.birth_date
    ? Math.floor((Date.now() - new Date(profile.birth_date).getTime()) / (365.25 * 86400_000))
    : 40

  let tz = 'Europe/Moscow'
  if (profile.current_location_id) {
    const { data: loc } = await db.from('locations').select('timezone').eq('id', profile.current_location_id).maybeSingle()
    if (loc?.timezone) tz = loc.timezone
  }
  const today = localDate(tz)
  const cacheKind = `metric_${type}`

  /* Кэш на день. */
  const { data: cached } = await db
    .from('messages')
    .select('content, context_snapshot')
    .eq('date', today)
    .eq('kind', cacheKind)
    .maybeSingle()
  if (cached) {
    return json({ ...(cached.context_snapshot as Record<string, unknown>), explanation: cached.content, cached: true })
  }

  let result: { type: string; today: unknown; trends: unknown; explanation: string | null } | null = null
  if (type === 'recovery') result = await buildRecovery(db, user.id, ageYears)
  else if (type === 'sleep')   result = await buildSleep(db, user.id, ageYears, tz)
  else if (type === 'hrv')     result = await buildHrv(db, user.id, ageYears)

  if (!result) return json({ error: 'no data available' }, 404)
  if (!result.explanation) return json({ error: 'claude failed' }, 502)

  await db.from('messages').insert({
    user_id: user.id,
    date: today,
    kind: cacheKind,
    content: result.explanation,
    model: CLAUDE_MODEL,
    context_snapshot: { today: result.today, trends: result.trends, type: result.type },
  })

  return json({ ...result, cached: false })
})
