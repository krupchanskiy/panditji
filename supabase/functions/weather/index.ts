/* Edge Function: weather
 * Возвращает текущую температуру в локации пользователя.
 * Лениво кэширует на 30 минут в таблице weather_log.
 * Источник: Open-Meteo (без ключа). */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CACHE_TTL_MIN = 30

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'missing authorization' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY')!

  /* Клиент работает в контексте пользователя — RLS гарантирует, что мы видим
   * только его профиль и его локации. */
  const db = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: { user }, error: userErr } = await db.auth.getUser()
  if (userErr || !user) return json({ error: 'invalid token' }, 401)

  const { data: profile, error: profileErr } = await db
    .from('user_profile')
    .select('current_location_id')
    .eq('id', user.id)
    .single()
  if (profileErr) return json({ error: profileErr.message }, 500)
  if (!profile?.current_location_id) return json({ error: 'no current location' }, 400)

  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, name, lat, lon')
    .eq('id', profile.current_location_id)
    .single()
  if (locErr || !location) return json({ error: 'location not found' }, 404)

  /* Кэш: если есть свежая запись — отдаём её. */
  const cutoffIso = new Date(Date.now() - CACHE_TTL_MIN * 60 * 1000).toISOString()
  const { data: cached } = await db
    .from('weather_log')
    .select('measured_at, temperature_c, feels_like_c')
    .eq('location_id', location.id)
    .gte('measured_at', cutoffIso)
    .order('measured_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (cached) {
    return json({
      temperature_c: Number(cached.temperature_c),
      feels_like_c: cached.feels_like_c !== null ? Number(cached.feels_like_c) : null,
      measured_at: cached.measured_at,
      location: { id: location.id, name: location.name },
      cached: true,
    })
  }

  /* Тянем свежее значение у Open-Meteo. */
  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(location.lat))
  url.searchParams.set('longitude', String(location.lon))
  url.searchParams.set('current', 'temperature_2m,apparent_temperature')
  url.searchParams.set('timezone', 'UTC')

  const resp = await fetch(url)
  if (!resp.ok) return json({ error: `open-meteo http ${resp.status}` }, 502)
  const wx = await resp.json()

  const temp = wx?.current?.temperature_2m
  const feels = wx?.current?.apparent_temperature
  if (typeof temp !== 'number') return json({ error: 'no temperature in response' }, 502)

  const measuredAt = new Date().toISOString()

  const { data: inserted, error: insErr } = await db
    .from('weather_log')
    .insert({
      user_id: user.id,
      location_id: location.id,
      measured_at: measuredAt,
      temperature_c: temp,
      feels_like_c: feels ?? null,
      raw_response: wx,
    })
    .select('measured_at, temperature_c, feels_like_c')
    .single()
  if (insErr) return json({ error: insErr.message }, 500)

  return json({
    temperature_c: Number(inserted.temperature_c),
    feels_like_c: inserted.feels_like_c !== null ? Number(inserted.feels_like_c) : null,
    measured_at: inserted.measured_at,
    location: { id: location.id, name: location.name },
    cached: false,
  })
})
