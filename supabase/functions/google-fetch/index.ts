/* Edge Function: google-fetch
 * Тянет события из Google Calendar (primary) за ближайшие 7 дней и upsert в calendar_events.
 * Аутентификация: пользовательский JWT (verify_jwt: true).
 * При истечении access_token — обновляет через refresh_token. */

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const GOOGLE_API_BASE = 'https://www.googleapis.com'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const FETCH_DAYS_FORWARD = 7
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

async function refreshAccessToken(
  admin: SupabaseClient,
  userId: string,
  refreshSecretId: string,
  accessSecretId: string,
): Promise<string> {
  const { data: refreshToken } = await admin.rpc('vault_read', { p_id: refreshSecretId })
  if (!refreshToken) throw new Error('refresh token not found in vault')

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

  if (!resp.ok) {
    const text = await resp.text()
    await admin.from('oauth_tokens').update({
      is_active: false,
      last_error: `refresh_failed_${resp.status}_${text.slice(0, 200)}`,
    }).eq('user_id', userId).eq('provider', 'google')
    throw new Error(`refresh failed: ${resp.status}`)
  }

  const tokens = await resp.json() as {
    access_token: string
    expires_in: number
  }

  await admin.rpc('vault_update', { p_id: accessSecretId, p_value: tokens.access_token })
  await admin.from('oauth_tokens').update({
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    last_used_at: new Date().toISOString(),
    last_error: null,
  }).eq('user_id', userId).eq('provider', 'google')

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

  const { data: tok, error: tokErr } = await admin
    .from('oauth_tokens')
    .select('access_token_secret_id, refresh_token_secret_id, expires_at, is_active')
    .eq('user_id', user.id)
    .eq('provider', 'google')
    .maybeSingle()
  if (tokErr) return json({ error: tokErr.message }, 500)
  if (!tok) return json({ skipped: 'no_token' })
  if (!tok.is_active) return json({ skipped: 'inactive_token' })

  let accessToken: string
  const expiresMs = new Date(tok.expires_at).getTime()
  if (expiresMs - Date.now() < REFRESH_BUFFER_MS && tok.refresh_token_secret_id) {
    accessToken = await refreshAccessToken(
      admin, user.id, tok.refresh_token_secret_id, tok.access_token_secret_id,
    )
  } else {
    const { data } = await admin.rpc('vault_read', { p_id: tok.access_token_secret_id })
    accessToken = data as string
  }

  const timeMin = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString() /* немного назад, чтобы поймать длинные события */
  const timeMax = new Date(Date.now() + FETCH_DAYS_FORWARD * 86400_000).toISOString()

  const url = new URL(`${GOOGLE_API_BASE}/calendar/v3/calendars/primary/events`)
  url.searchParams.set('timeMin', timeMin)
  url.searchParams.set('timeMax', timeMax)
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', '50')

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!resp.ok) {
    const text = await resp.text()
    return json({ error: `google ${resp.status}`, body: text.slice(0, 500) }, 502)
  }

  const body = await resp.json() as {
    items?: Array<Record<string, any>>
    timeZone?: string
  }
  const calendarTz = body.timeZone ?? 'UTC'
  const items = body.items ?? []

  const result = { inserted: 0, updated: 0, skipped: 0, errors: [] as string[] }
  const seenGoogleIds: string[] = []

  for (const ev of items) {
    if (ev.status === 'cancelled') continue
    const startObj = ev.start ?? {}
    const endObj = ev.end ?? {}
    const isAllDay = !!startObj.date && !startObj.dateTime
    const startAt = startObj.dateTime ?? (startObj.date ? `${startObj.date}T00:00:00Z` : null)
    const endAt   = endObj.dateTime   ?? (endObj.date   ? `${endObj.date}T00:00:00Z`   : null)
    if (!startAt) { result.skipped++; continue }
    if (!ev.id) { result.skipped++; continue }

    seenGoogleIds.push(ev.id)

    const { error } = await admin.from('calendar_events').upsert({
      user_id: user.id,
      google_event_id: ev.id,
      google_calendar_id: 'primary',
      title: ev.summary ?? '(без названия)',
      description: ev.description ?? null,
      location_text: ev.location ?? null,
      start_at: startAt,
      end_at: endAt,
      is_all_day: isAllDay,
      timezone: startObj.timeZone ?? endObj.timeZone ?? calendarTz,
      source: 'google_calendar',
      deleted_at: null,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'google_event_id' })
    if (error) result.errors.push(error.message)
    else result.inserted++
  }

  /* Soft-delete: события которые были у нас, но пропали из ответа Google за этот период. */
  if (seenGoogleIds.length > 0) {
    await admin.from('calendar_events')
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('source', 'google_calendar')
      .is('deleted_at', null)
      .gte('start_at', timeMin)
      .lte('start_at', timeMax)
      .not('google_event_id', 'in', `(${seenGoogleIds.map((id) => `"${id.replace(/"/g, '\\"')}"`).join(',')})`)
  }

  await admin.from('oauth_tokens').update({
    last_used_at: new Date().toISOString(),
  }).eq('user_id', user.id).eq('provider', 'google')

  return json(result)
})
