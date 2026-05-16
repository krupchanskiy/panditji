/* Edge Function: get-home-bundle
 *
 * Объединённый запрос для главной страницы — profile + weather + health за один
 * round-trip. Раньше клиент делал 3 отдельных fetch'а (loadProfile, loadWeather,
 * loadHealth) — каждый со своим TLS-handshake, JWT-verify и потенциальным
 * cold-start. Здесь делаем всё параллельно на сервере и отдаём один JSON.
 *
 * Логика weather и health повторяет существующие EF (`weather` и
 * `get-health-summary-widget`) — сознательное дублирование на момент MVP.
 * Когда понадобится третий потребитель — вынести в `_shared/`.
 *
 * Auth: user JWT. RLS limits to current user.
 * Deploy: supabase functions deploy get-home-bundle --project-ref intcymsjpbkyrflfcwzf
 */

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

/* ───── CORS ─────────────────────────────────────────────────────── */

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

/* ───── Constants ────────────────────────────────────────────────── */

const WEATHER_CACHE_TTL_MIN = 30
const BASELINE_MIN_NIGHTS = 5
const BASELINE_DAYS = 30
const STALE_SLEEP_HOURS = 36
const STREAK_MIN_DAYS = 3
const SLEEP_GOOD_HOURS = 7
const RECOVERY_GOOD_SCORE = 70
const USER_TZ_FALLBACK = 'Europe/Moscow'

/* ───── Main handler ─────────────────────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeadersFor(req) })
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, req)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) return json({ error: 'server_misconfigured' }, 500)

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthorized' }, 401, req)
  const db = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  })

  const { data: { user } } = await db.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401, req)

  /* Сначала тянем профиль и локацию — от них зависит и weather, и health. */
  const { data: profileRow } = await db
    .from('user_profile')
    .select('current_location_id, location:current_location_id(name, timezone, lat, lon)')
    .eq('id', user.id)
    .maybeSingle()

  const loc = (profileRow as any)?.location
  const tz: string = loc?.timezone || USER_TZ_FALLBACK
  const locationName: string = loc?.name || ''
  const locationId: string | null = (profileRow as any)?.current_location_id ?? null

  /* Дальше weather и health параллельно. */
  const [weather, health] = await Promise.all([
    loadWeather(db, locationId, loc?.lat, loc?.lon),
    loadHealth(db, tz),
  ])

  return json({
    profile: { tz, locationName },
    weather,
    health,
  }, 200, req)
})

/* ───── Weather ──────────────────────────────────────────────────── */

interface WeatherPayload { temperature_c: number | null }

async function loadWeather(
  db: SupabaseClient,
  locationId: string | null,
  lat: number | null | undefined,
  lon: number | null | undefined,
): Promise<WeatherPayload> {
  if (!locationId || lat == null || lon == null) return { temperature_c: null }

  /* Кэш в weather_log: если свежая запись есть — отдаём её. */
  const cutoffIso = new Date(Date.now() - WEATHER_CACHE_TTL_MIN * 60 * 1000).toISOString()
  const { data: cached } = await db
    .from('weather_log')
    .select('temperature_c')
    .eq('location_id', locationId)
    .gte('measured_at', cutoffIso)
    .order('measured_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (cached?.temperature_c != null) {
    return { temperature_c: Number(cached.temperature_c) }
  }

  /* Свежее значение у Open-Meteo. */
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude',  String(lat))
  url.searchParams.set('longitude', String(lon))
  url.searchParams.set('current',   'temperature_2m,apparent_temperature')
  url.searchParams.set('timezone',  'auto')

  try {
    const resp = await fetch(url.toString())
    if (!resp.ok) return { temperature_c: null }
    const data = await resp.json()
    const t = Number(data?.current?.temperature_2m)
    if (!Number.isFinite(t)) return { temperature_c: null }
    const feels = Number(data?.current?.apparent_temperature)
    /* Пишем в weather_log для будущих запросов (fire-and-forget). */
    db.from('weather_log').insert({
      location_id: locationId,
      temperature_c: t,
      feels_like_c: Number.isFinite(feels) ? feels : null,
      measured_at: new Date().toISOString(),
      source: 'open-meteo',
    }).then(() => {}).catch(() => {})
    return { temperature_c: t }
  } catch (e) {
    console.warn('weather fetch failed', e)
    return { temperature_c: null }
  }
}

/* ───── Health ───────────────────────────────────────────────────── */

interface HealthPayload {
  state: 'fresh' | 'stale' | 'no_data' | 'no_baseline'
  syncedAt: string | null
  metrics: any
  streaks: string[]
  nightsCollected: number
  extra: any
}

async function loadHealth(db: SupabaseClient, tz: string): Promise<HealthPayload> {
  const today = localDate(new Date(), tz)
  const fromDate = isoSubDays(today, BASELINE_DAYS)
  const fromTs = new Date(fromDate + 'T00:00:00Z').toISOString()

  const [recRes, sleepRes, workoutRes] = await Promise.all([
    db.from('whoop_recovery')
      .select('date, recovery_score, hrv_rmssd_ms, resting_heart_rate, created_at')
      .gte('date', fromDate)
      .order('date', { ascending: false }),
    db.from('whoop_sleeps')
      .select('id, start_at, end_at, duration_seconds, sleep_efficiency, hrv_rmssd_ms, resting_heart_rate, created_at')
      .gte('end_at', fromTs)
      .order('end_at', { ascending: false }),
    db.from('whoop_workouts')
      .select('start_at, strain')
      .gte('start_at', fromTs)
      .order('start_at', { ascending: false }),
  ])

  if (recRes.error || sleepRes.error || workoutRes.error) {
    console.warn('whoop fetch error', recRes.error, sleepRes.error, workoutRes.error)
    return emptyHealth('no_data', null)
  }

  const recoveries = recRes.data ?? []
  const sleeps     = sleepRes.data ?? []
  const workouts   = workoutRes.data ?? []

  const latestRec   = recoveries[0]
  const latestSleep = sleeps[0]

  const latestSyncTs = maxTs([
    ...recoveries.map((r: any) => r.created_at),
    ...sleeps.map((s: any) => s.created_at),
  ])
  const syncedAt = latestSyncTs ? formatSyncedAt(new Date(latestSyncTs), tz) : null

  if (!latestRec && !latestSleep) return emptyHealth('no_data', null)

  const latestSleepAgeH = latestSleep
    ? (Date.now() - Date.parse(latestSleep.end_at)) / 3600_000
    : Infinity
  if (latestSleepAgeH > STALE_SLEEP_HOURS) return emptyHealth('stale', syncedAt)

  const baselineRec   = recoveries.filter((r: any) => latestRec ? r !== latestRec : true)
  const baselineSleep = sleeps.filter((s: any) => latestSleep ? s !== latestSleep : true)
  const nightsCollected = baselineSleep.length

  const strainByDay = new Map<string, number>()
  for (const w of workouts as any[]) {
    const d = localDate(new Date(w.start_at), tz)
    strainByDay.set(d, (strainByDay.get(d) || 0) + Number(w.strain || 0))
  }
  const currentDay = latestSleep ? localDate(new Date(latestSleep.end_at), tz) : today
  const todayStrain = strainByDay.get(currentDay) ?? 0
  const baselineStrainValues = Array.from(strainByDay.entries())
    .filter(([d]) => d !== currentDay)
    .map(([, v]) => v)

  const baselineReady = nightsCollected >= BASELINE_MIN_NIGHTS

  const hrvToday = latestRec?.hrv_rmssd_ms ?? latestSleep?.hrv_rmssd_ms ?? null
  const rhrToday = latestRec?.resting_heart_rate ?? latestSleep?.resting_heart_rate ?? null

  const recoveryToday = latestRec?.recovery_score ?? null
  const recoveryBaseline = baselineReady ? avg(baselineRec.map((r: any) => r.recovery_score)) : null

  const sleepTodaySec    = latestSleep?.duration_seconds ?? null
  const sleepBaselineSec = baselineReady ? avg(baselineSleep.map((s: any) => s.duration_seconds)) : null

  const hrvBaseline    = baselineReady ? avg(baselineRec.map((r: any) => r.hrv_rmssd_ms).filter(notNull)) : null
  const rhrBaseline    = baselineReady ? avg(baselineRec.map((r: any) => r.resting_heart_rate).filter(notNull)) : null
  const strainBaseline = baselineReady && baselineStrainValues.length >= 5
    ? avg(baselineStrainValues) : null

  const sleepStreak = streakBack(currentDay, BASELINE_DAYS, (d) => {
    const s = sleeps.find((s: any) => localDate(new Date(s.end_at), tz) === d) as any
    return s ? s.duration_seconds >= SLEEP_GOOD_HOURS * 3600 : false
  })
  const recoveryStreak = streakBack(currentDay, BASELINE_DAYS, (d) => {
    const r = recoveries.find((r: any) => r.date === d) as any
    return r ? r.recovery_score >= RECOVERY_GOOD_SCORE : false
  })
  const streaks: string[] = []
  if (sleepStreak >= STREAK_MIN_DAYS) streaks.push(`${sleepStreak} ${pluralNoch(sleepStreak)} сон ≥ ${SLEEP_GOOD_HOURS}ч`)
  if (recoveryStreak >= STREAK_MIN_DAYS) streaks.push(`${recoveryStreak} ${pluralDen(recoveryStreak)} recov ≥ ${RECOVERY_GOOD_SCORE}`)

  const state: HealthPayload['state'] = baselineReady ? 'fresh' : 'no_baseline'

  return {
    state, syncedAt,
    metrics: {
      recovery: {
        today: recoveryToday,
        baseline: recoveryBaseline != null ? Math.round(recoveryBaseline) : null,
        delta: (recoveryToday != null && recoveryBaseline != null)
          ? Math.round(recoveryToday - recoveryBaseline) : null,
        inverted: false, unit: '%',
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
  }
}

function emptyHealth(state: 'no_data' | 'stale', syncedAt: string | null): HealthPayload {
  return { state, syncedAt, metrics: null, streaks: [], nightsCollected: 0, extra: null }
}

/* ───── Helpers (shared utils, копия из get-health-summary-widget) ─ */

function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}
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
function streakBack(todayISO: string, maxDays: number, predicate: (d: string) => boolean): number {
  let count = 0
  for (let i = 0; i < maxDays; i++) {
    const d = isoSubDays(todayISO, i)
    if (predicate(d)) count++
    else break
  }
  return count
}
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
