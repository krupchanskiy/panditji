/* Edge Function: get-health-summary-widget
 *
 * Compact Whoop summary for the home dashboard "Здоровье" card.
 *
 * States:
 *   no_data     — no recovery/sleep in last 48h, or no Whoop link at all
 *   stale       — latest sync >12h ago
 *   no_baseline — fresh data but <5 nights total in DB
 *   fresh       — fresh data + baseline ready
 *
 * Metrics (today + 30-day baseline + delta):
 *   recovery (whoop_recovery.recovery_score), sleep (whoop_sleeps.duration_seconds),
 *   strain (SUM whoop_workouts.strain per day)
 *
 * Extra (only when fresh): rhr, hrv from whoop_recovery.
 *
 * Streaks: "N ночей сон ≥ 7ч", "N дней recov ≥ 70" — only if ≥3.
 *
 * Auth: user JWT. RLS limits to current user.
 * Deploy: supabase functions deploy get-health-summary-widget --project-ref intcymsjpbkyrflfcwzf
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'

/* Allow-Headers эхом отражает запрошенный preflight'ом список — иначе браузер
 * блокирует actual GET, если supabase-js шлёт служебные заголовки (x-client-info
 * и т.п.), которых нет в hardcoded allow-list. */
function corsHeadersFor(req: Request): Record<string, string> {
  const requested = req.headers.get('access-control-request-headers')
    ?? 'authorization, content-type, apikey, x-client-info, x-supabase-api-version'
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': requested,
    'Access-Control-Max-Age': '86400',
  }
}

function json(body: unknown, status = 200, req?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(req ? corsHeadersFor(req) : {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info, x-supabase-api-version',
      }),
      'Content-Type': 'application/json',
    },
  })
}

const BASELINE_MIN_NIGHTS = 5
const BASELINE_DAYS = 30
const STALE_SLEEP_HOURS = 36   /* Если последний сон закончился >36ч назад — данных «нет» (>1 пропущенной ночи). */
const STREAK_MIN_DAYS = 3
const SLEEP_GOOD_HOURS = 7
const RECOVERY_GOOD_SCORE = 70
const USER_TZ_DEFAULT = 'Asia/Kolkata'  // TODO: user_profile.current_tz

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeadersFor(req) })
  /* GET — наш «канонический» вызов, POST — supabase-js .functions.invoke() defaults. Принимаем оба. */
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, req)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) return json({ error: 'server_misconfigured' }, 500)

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthorized' }, 401)
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  })

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  const tz = USER_TZ_DEFAULT
  const today = localDate(new Date(), tz)
  const fromDate = isoSubDays(today, BASELINE_DAYS)
  const fromTs = new Date(fromDate + 'T00:00:00Z').toISOString()

  /* Параллельно тянем три потока за последние 31 день + одну ночь сна
   * вне окна на случай, если сегодняшний сон не пришёл и нужен fallback на вчерашний. */
  const [recRes, sleepRes, workoutRes] = await Promise.all([
    supabase
      .from('whoop_recovery')
      .select('date, recovery_score, hrv_rmssd_ms, resting_heart_rate, created_at')
      .gte('date', fromDate)
      .order('date', { ascending: false }),
    supabase
      .from('whoop_sleeps')
      .select('id, start_at, end_at, duration_seconds, sleep_efficiency, hrv_rmssd_ms, resting_heart_rate, created_at')
      .gte('end_at', fromTs)
      .order('end_at', { ascending: false }),
    supabase
      .from('whoop_workouts')
      .select('start_at, strain')
      .gte('start_at', fromTs)
      .order('start_at', { ascending: false }),
  ])

  if (recRes.error)     return json({ error: 'db_error', message: recRes.error.message }, 500)
  if (sleepRes.error)   return json({ error: 'db_error', message: sleepRes.error.message }, 500)
  if (workoutRes.error) return json({ error: 'db_error', message: workoutRes.error.message }, 500)

  const recoveries = recRes.data ?? []
  const sleeps = sleepRes.data ?? []
  const workouts = workoutRes.data ?? []

  /* «Текущие» данные — самые свежие записи, безотносительно календарной даты.
   * Это покрывает кейс «01:15 ночи нового дня — за сегодня данных ещё нет,
   * но вчерашние числа уже хороший срез последнего сна». */
  const latestRec   = recoveries[0]
  const latestSleep = sleeps[0]

  /* Latest sync — наибольший created_at среди всех потоков. */
  const latestSyncTs = maxTs([
    ...recoveries.map(r => r.created_at),
    ...sleeps.map(s => s.created_at),
  ])
  const syncedAt = latestSyncTs ? formatSyncedAt(new Date(latestSyncTs), tz) : null

  /* No data: вообще нет записей. */
  if (!latestRec && !latestSleep) {
    return json(empty('no_data', null))
  }

  /* Stale: последний сон закончился >36ч назад (пропустили ≥ ночь). */
  const latestSleepAgeH = latestSleep
    ? (Date.now() - Date.parse(latestSleep.end_at)) / 3600_000
    : Infinity
  if (latestSleepAgeH > STALE_SLEEP_HOURS) {
    return json(empty('stale', syncedAt))
  }

  /* Baseline — все записи КРОМЕ «текущей». */
  const baselineRec = recoveries.filter(r => latestRec ? r !== latestRec : true)
  const baselineSleep = sleeps.filter(s => latestSleep ? s !== latestSleep : true)
  const nightsCollected = baselineSleep.length

  /* Strain — суммируем workouts по дням локальной TZ; «сегодняшний» = за дату последнего сна. */
  const strainByDay = new Map<string, number>()
  for (const w of workouts) {
    const d = localDate(new Date(w.start_at), tz)
    strainByDay.set(d, (strainByDay.get(d) || 0) + Number(w.strain || 0))
  }
  const currentDay = latestSleep ? localDate(new Date(latestSleep.end_at), tz) : today
  const todayStrain = strainByDay.get(currentDay) ?? 0
  const baselineStrainValues = Array.from(strainByDay.entries())
    .filter(([d]) => d !== currentDay)
    .map(([, v]) => v)

  const baselineReady = nightsCollected >= BASELINE_MIN_NIGHTS

  /* HRV / RHR — из последнего recovery (или fallback на последний сон). */
  const hrvToday = latestRec?.hrv_rmssd_ms ?? latestSleep?.hrv_rmssd_ms ?? null
  const rhrToday = latestRec?.resting_heart_rate ?? latestSleep?.resting_heart_rate ?? null

  /* Recovery */
  const recoveryToday = latestRec?.recovery_score ?? null
  const recoveryBaseline = baselineReady ? avg(baselineRec.map(r => r.recovery_score)) : null

  /* Sleep — duration_seconds. */
  const sleepTodaySec = latestSleep?.duration_seconds ?? null
  const sleepBaselineSec = baselineReady ? avg(baselineSleep.map(s => s.duration_seconds)) : null

  /* HRV / RHR baseline. */
  const hrvBaseline = baselineReady ? avg(baselineRec.map(r => r.hrv_rmssd_ms).filter(notNull)) : null
  const rhrBaseline = baselineReady ? avg(baselineRec.map(r => r.resting_heart_rate).filter(notNull)) : null
  const strainBaseline = baselineReady && baselineStrainValues.length >= 5
    ? avg(baselineStrainValues) : null

  /* Стрики — пробегаем назад от даты последнего сна, считаем подряд. */
  const sleepStreak = streakBack(currentDay, BASELINE_DAYS, (d) => {
    const s = sleeps.find(s => localDate(new Date(s.end_at), tz) === d)
    return s ? s.duration_seconds >= SLEEP_GOOD_HOURS * 3600 : false
  })
  const recoveryStreak = streakBack(currentDay, BASELINE_DAYS, (d) => {
    const r = recoveries.find(r => r.date === d)
    return r ? r.recovery_score >= RECOVERY_GOOD_SCORE : false
  })

  const streaks: string[] = []
  if (sleepStreak >= STREAK_MIN_DAYS) {
    streaks.push(`${sleepStreak} ${pluralNoch(sleepStreak)} сон ≥ ${SLEEP_GOOD_HOURS}ч`)
  }
  if (recoveryStreak >= STREAK_MIN_DAYS) {
    streaks.push(`${recoveryStreak} ${pluralDen(recoveryStreak)} recov ≥ ${RECOVERY_GOOD_SCORE}`)
  }

  const state = baselineReady ? 'fresh' : 'no_baseline'

  return json({
    state,
    syncedAt,
    metrics: {
      recovery: {
        today: recoveryToday,
        baseline: recoveryBaseline != null ? Math.round(recoveryBaseline) : null,
        delta: (recoveryToday != null && recoveryBaseline != null)
          ? Math.round(recoveryToday - recoveryBaseline) : null,
        inverted: false,
        unit: '%',
      },
      sleep: {
        today: sleepTodaySec != null ? secToHM(sleepTodaySec) : null,
        baseline: sleepBaselineSec != null ? secToHM(sleepBaselineSec) : null,
        deltaSec: (sleepTodaySec != null && sleepBaselineSec != null)
          ? Math.round(sleepTodaySec - sleepBaselineSec) : null,
        inverted: false,
      },
      strain: {
        today: round1(todayStrain),
        baseline: strainBaseline != null ? round1(strainBaseline) : null,
        delta: (strainBaseline != null) ? round1(todayStrain - strainBaseline) : null,
        neutral: true,
      },
    },
    streaks,
    nightsCollected,
    extra: baselineReady ? {
      rhr: rhrToday != null && rhrBaseline != null ? {
        today: rhrToday, baseline: Math.round(rhrBaseline),
        delta: rhrToday - Math.round(rhrBaseline), inverted: true,
      } : null,
      hrv: hrvToday != null && hrvBaseline != null ? {
        today: Math.round(Number(hrvToday)), baseline: Math.round(hrvBaseline),
        delta: Math.round(Number(hrvToday) - hrvBaseline), inverted: false,
      } : null,
    } : null,
  })
})

function empty(state: 'no_data' | 'stale', syncedAt: string | null) {
  return {
    state, syncedAt,
    metrics: null, streaks: [], nightsCollected: 0, extra: null,
  }
}

/* Локальная дата YYYY-MM-DD для Date в указанной IANA TZ. */
function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/* Дата за N дней до базовой ISO. */
function isoSubDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function avg(xs: (number | null | undefined)[]): number | null {
  const ns = xs.filter((v): v is number => v != null && !Number.isNaN(Number(v))).map(Number)
  if (!ns.length) return null
  return ns.reduce((s, v) => s + v, 0) / ns.length
}

function notNull<T>(v: T | null | undefined): v is T { return v != null }

function maxTs(ts: (string | null | undefined)[]): string | null {
  let best: number | null = null
  for (const t of ts) {
    if (!t) continue
    const ms = Date.parse(t)
    if (best === null || ms > best) best = ms
  }
  return best === null ? null : new Date(best).toISOString()
}

function secToHM(sec: number): { h: number, m: number } {
  const total = Math.round(sec / 60)
  return { h: Math.floor(total / 60), m: total % 60 }
}

function round1(v: number): number { return Math.round(v * 10) / 10 }

/* "12 ночей" / "1 ночь" / "2 ночи" / "5 ночей". */
function pluralNoch(n: number): string {
  const mod10 = n % 10, mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'ночь'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'ночи'
  return 'ночей'
}
function pluralDen(n: number): string {
  const mod10 = n % 10, mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'день'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дня'
  return 'дней'
}

/* Идём назад от today по dateISO; считаем максимум подряд по предикату. */
function streakBack(todayISO: string, maxDays: number, predicate: (d: string) => boolean): number {
  let count = 0
  for (let i = 0; i < maxDays; i++) {
    const d = isoSubDays(todayISO, i)
    if (predicate(d)) count++
    else break
  }
  return count
}

/* "06:14" если сегодня; "вчера, 22:30"; иначе "14 мая, 09:15". */
function formatSyncedAt(d: Date, tz: string): string {
  const today = localDate(new Date(), tz)
  const dDay = localDate(d, tz)
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d)
  if (dDay === today) return time
  const yesterday = isoSubDays(today, 1)
  if (dDay === yesterday) return `вчера, ${time}`
  const day = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, day: 'numeric' }).format(d))
  const monthIdx = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: 'numeric' }).format(d)) - 1
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря']
  return `${day} ${months[monthIdx]}, ${time}`
}
