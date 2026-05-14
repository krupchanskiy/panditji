/* Edge Function: astro-api
 *
 * Возвращает вайшнавский календарь для текущей локации пользователя.
 *
 * Один endpoint, ?kind=... управляет ответом:
 *   - kind=brief (default) — для утреннего экрана: сегодня + ближайшая экадаши.
 *   - kind=upcoming        — ближайшая экадаши.
 *   - kind=today           — события сегодня (appearance/disappearance/purnima/caturmasya).
 *   - kind=month&year=YYYY&month=M — все события месяца (для будущего экрана-календаря).
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const url = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'missing auth' }, 401)

  const supabase = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  // Текущая локация — из user_profile.current_location_id
  const { data: prof, error: profErr } = await supabase
    .from('user_profile')
    .select('current_location_id, locations:current_location_id(id, key, name, timezone)')
    .eq('id', user.id)
    .single()
  if (profErr || !prof) return json({ error: 'profile not found' }, 404)

  const loc = (prof.locations as { id: string; key: string; name: string; timezone: string } | null)
  if (!loc) return json({ error: 'no current location' }, 404)

  const params = new URL(req.url).searchParams
  const kind = params.get('kind') || 'brief'
  const today = localDate(loc.timezone)

  // ---- kind=upcoming: ближайшая экадаши (без горизонта) ----
  if (kind === 'upcoming') {
    const { data, error } = await supabase
      .from('vaishnava_calendar')
      .select('event_date, event_name, ekadashi_type, fasting_start_at, fasting_end_at, paran_start_at, paran_end_at, paran_type, paran_start_reason, paran_end_reason')
      .eq('user_id', user.id)
      .eq('location_id', loc.id)
      .eq('event_type', 'ekadashi')
      .gte('event_date', today)
      .order('event_date', { ascending: true })
      .limit(1)
    if (error) return json({ error: error.message }, 500)
    return json({ location: loc, today, upcoming_ekadashi: data?.[0] ?? null })
  }

  // ---- kind=today: события сегодня (без экадаши — её отдельно через upcoming) ----
  if (kind === 'today') {
    const { data, error } = await supabase
      .from('vaishnava_calendar')
      .select('event_type, event_name, description')
      .eq('user_id', user.id)
      .eq('location_id', loc.id)
      .eq('event_date', today)
      .in('event_type', ['appearance', 'disappearance', 'purnima', 'amavasya', 'caturmasya_start', 'caturmasya_end'])
      .order('event_type')
    if (error) return json({ error: error.message }, 500)
    return json({ location: loc, today, events: data ?? [] })
  }

  // ---- kind=month: события месяца ----
  if (kind === 'month') {
    const year = Number(params.get('year'))
    const month = Number(params.get('month'))
    if (!year || !month) return json({ error: 'year/month required' }, 400)
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
    const nextMonthStart = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`
    const { data, error } = await supabase
      .from('vaishnava_calendar')
      .select('event_date, event_type, event_name, ekadashi_type, paran_start_at, paran_end_at, description')
      .eq('user_id', user.id)
      .eq('location_id', loc.id)
      .gte('event_date', monthStart)
      .lt('event_date', nextMonthStart)
      .order('event_date')
    if (error) return json({ error: error.message }, 500)
    return json({ location: loc, year, month, events: data ?? [] })
  }

  // ---- kind=brief (default): сегодня + ближайшая экадаши (без горизонта) ----
  const [upcomingRes, todayRes] = await Promise.all([
    supabase
      .from('vaishnava_calendar')
      .select('event_date, event_name, ekadashi_type, fasting_start_at, fasting_end_at, paran_start_at, paran_end_at, paran_type, paran_start_reason, paran_end_reason')
      .eq('user_id', user.id)
      .eq('location_id', loc.id)
      .eq('event_type', 'ekadashi')
      .gte('event_date', today)
      .order('event_date', { ascending: true })
      .limit(1),
    supabase
      .from('vaishnava_calendar')
      .select('event_type, event_name, description')
      .eq('user_id', user.id)
      .eq('location_id', loc.id)
      .eq('event_date', today)
      .in('event_type', ['appearance', 'disappearance', 'purnima', 'amavasya', 'caturmasya_start', 'caturmasya_end']),
  ])
  if (upcomingRes.error) return json({ error: upcomingRes.error.message }, 500)
  if (todayRes.error) return json({ error: todayRes.error.message }, 500)

  return json({
    location: loc,
    today,
    upcoming_ekadashi: upcomingRes.data?.[0] ?? null,
    today_events: todayRes.data ?? [],
  })
})
