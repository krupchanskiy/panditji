/* Edge Function: whoop-fetch
 * Тянет последние 7 дней данных из Whoop API: recovery, sleep, workout.
 * Аутентификация: пользовательский JWT (verify_jwt: true).
 * Использует токены из oauth_tokens + supabase_vault.
 * При истечении access_token — обновляет через refresh_token. */

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const WHOOP_BASE = 'https://api.prod.whoop.com'
const FETCH_DAYS_BACK = 7
const REFRESH_BUFFER_MS = 5 * 60 * 1000

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

function ms2s(ms?: number | null): number | null {
  return typeof ms === 'number' ? Math.round(ms / 1000) : null
}

async function whoopGet(
  token: string,
  path: string,
  params: Record<string, string> = {},
): Promise<{ records: unknown[]; status: number; error?: string }> {
  const url = new URL(WHOOP_BASE + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!resp.ok) {
    return { records: [], status: resp.status, error: await resp.text() }
  }
  const body = await resp.json() as { records?: unknown[] }
  return { records: body.records ?? [], status: resp.status }
}

async function refreshAccessToken(
  admin: SupabaseClient,
  userId: string,
  refreshSecretId: string,
  accessSecretId: string,
): Promise<string> {
  const { data: refreshToken } = await admin.rpc('vault_read', { p_id: refreshSecretId })
  if (!refreshToken) throw new Error('refresh token not found in vault')

  const resp = await fetch(`${WHOOP_BASE}/oauth/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken as string,
      client_id: Deno.env.get('WHOOP_CLIENT_ID')!,
      client_secret: Deno.env.get('WHOOP_CLIENT_SECRET')!,
      scope: 'offline',
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    await admin.from('oauth_tokens').update({
      is_active: false,
      last_error: `refresh_failed_${resp.status}_${text.slice(0, 200)}`,
    }).eq('user_id', userId).eq('provider', 'whoop')
    throw new Error(`refresh failed: ${resp.status}`)
  }

  const tokens = await resp.json() as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }

  await admin.rpc('vault_update', { p_id: accessSecretId, p_value: tokens.access_token })
  if (tokens.refresh_token) {
    await admin.rpc('vault_update', { p_id: refreshSecretId, p_value: tokens.refresh_token })
  }
  await admin.from('oauth_tokens').update({
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    last_used_at: new Date().toISOString(),
    last_error: null,
  }).eq('user_id', userId).eq('provider', 'whoop')

  return tokens.access_token
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'missing authorization' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const userDb = createClient(supabaseUrl, anon, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: userErr } = await userDb.auth.getUser()
  if (userErr || !user) return json({ error: 'invalid token' }, 401)

  const admin = createClient(supabaseUrl, svc)

  /* Достаём токены пользователя. */
  const { data: tok, error: tokErr } = await admin
    .from('oauth_tokens')
    .select('access_token_secret_id, refresh_token_secret_id, expires_at, is_active')
    .eq('user_id', user.id)
    .eq('provider', 'whoop')
    .maybeSingle()
  if (tokErr) return json({ error: tokErr.message }, 500)
  if (!tok) return json({ skipped: 'no_token', message: 'Whoop не подключён' })
  if (!tok.is_active) return json({ skipped: 'inactive_token', message: 'Whoop отключён — нужна переавторизация' })

  /* Получаем access_token, рефрешим если скоро истечёт. */
  let accessToken: string
  const expiresMs = new Date(tok.expires_at).getTime()
  if (expiresMs - Date.now() < REFRESH_BUFFER_MS && tok.refresh_token_secret_id) {
    accessToken = await refreshAccessToken(
      admin,
      user.id,
      tok.refresh_token_secret_id,
      tok.access_token_secret_id,
    )
  } else {
    const { data } = await admin.rpc('vault_read', { p_id: tok.access_token_secret_id })
    accessToken = data as string
  }

  /* Тянем последние 7 дней по трём эндпоинтам. */
  const startIso = new Date(Date.now() - FETCH_DAYS_BACK * 86400_000).toISOString()
  const [sleepRes, recoveryRes, workoutRes] = await Promise.all([
    whoopGet(accessToken, '/developer/v1/activity/sleep',   { start: startIso, limit: '25' }),
    whoopGet(accessToken, '/developer/v1/recovery',         { start: startIso, limit: '25' }),
    whoopGet(accessToken, '/developer/v1/activity/workout', { start: startIso, limit: '25' }),
  ])

  const result = {
    sleeps: 0, recoveries: 0, workouts: 0,
    errors: [] as Array<{ kind: string; status: number; body?: string }>,
  }
  if (sleepRes.error)    result.errors.push({ kind: 'sleep',    status: sleepRes.status,    body: sleepRes.error })
  if (recoveryRes.error) result.errors.push({ kind: 'recovery', status: recoveryRes.status, body: recoveryRes.error })
  if (workoutRes.error)  result.errors.push({ kind: 'workout',  status: workoutRes.status,  body: workoutRes.error })

  /* ---- Sleeps ---- */
  for (const raw of sleepRes.records as Array<Record<string, any>>) {
    const stage = raw.score?.stage_summary ?? {}
    const score = raw.score ?? {}
    const inBedMs = stage.total_in_bed_time_milli
    const { error } = await admin.from('whoop_sleeps').upsert({
      user_id: user.id,
      whoop_id: String(raw.id),
      start_at: raw.start,
      end_at: raw.end,
      timezone_offset: raw.timezone_offset ?? '+00:00',
      duration_seconds: ms2s(inBedMs) ?? 0,
      sleep_efficiency: score.sleep_efficiency_percentage ?? null,
      sleep_performance: score.sleep_performance_percentage ?? null,
      light_sleep_seconds: ms2s(stage.total_light_sleep_time_milli),
      deep_sleep_seconds:  ms2s(stage.total_slow_wave_sleep_time_milli),
      rem_sleep_seconds:   ms2s(stage.total_rem_sleep_time_milli),
      awake_seconds:       ms2s(stage.total_awake_time_milli),
      disturbance_count:   stage.disturbance_count ?? null,
      respiratory_rate:    score.respiratory_rate ?? null,
      raw_response: raw,
    }, { onConflict: 'whoop_id' })
    if (error) result.errors.push({ kind: 'sleep_upsert', status: 500, body: error.message })
    else result.sleeps++
  }

  /* ---- Workouts ---- */
  for (const raw of workoutRes.records as Array<Record<string, any>>) {
    const score = raw.score ?? {}
    const startMs = new Date(raw.start).getTime()
    const endMs = new Date(raw.end).getTime()
    const { error } = await admin.from('whoop_workouts').upsert({
      user_id: user.id,
      whoop_id: String(raw.id),
      start_at: raw.start,
      end_at: raw.end,
      duration_seconds: Math.max(0, Math.round((endMs - startMs) / 1000)),
      sport: raw.sport_name ?? raw.sport_id?.toString() ?? null,
      strain: score.strain ?? null,
      avg_heart_rate: score.average_heart_rate ?? null,
      max_heart_rate: score.max_heart_rate ?? null,
      kilojoules: score.kilojoule ?? null,
      raw_response: raw,
    }, { onConflict: 'whoop_id' })
    if (error) result.errors.push({ kind: 'workout_upsert', status: 500, body: error.message })
    else result.workouts++
  }

  /* ---- Recovery ---- */
  for (const raw of recoveryRes.records as Array<Record<string, any>>) {
    const sc = raw.score ?? {}
    let internalSleepId: string | null = null
    if (raw.sleep_id) {
      const { data: sleep } = await admin
        .from('whoop_sleeps')
        .select('id')
        .eq('whoop_id', String(raw.sleep_id))
        .maybeSingle()
      internalSleepId = sleep?.id ?? null
    }
    const date = (raw.created_at ?? new Date().toISOString()).slice(0, 10)
    const { error } = await admin.from('whoop_recovery').upsert({
      user_id: user.id,
      whoop_id: String(raw.id ?? raw.cycle_id),
      date,
      sleep_id: internalSleepId,
      recovery_score: sc.recovery_score ?? 0,
      hrv_rmssd_ms: sc.hrv_rmssd_milli ?? null,
      resting_heart_rate: sc.resting_heart_rate ?? null,
      respiratory_rate: sc.respiratory_rate ?? null,
      spo2_percentage: sc.spo2_percentage ?? null,
      skin_temp_celsius: sc.skin_temp_celsius ?? null,
      raw_response: raw,
    }, { onConflict: 'whoop_id' })
    if (error) result.errors.push({ kind: 'recovery_upsert', status: 500, body: error.message })
    else result.recoveries++
  }

  await admin.from('oauth_tokens').update({
    last_used_at: new Date().toISOString(),
  }).eq('user_id', user.id).eq('provider', 'whoop')

  return json(result)
})
