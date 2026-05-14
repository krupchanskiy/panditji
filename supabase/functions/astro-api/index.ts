/* Edge Function: astro-api
 *
 * Возвращает вайшнавский календарь для пользователя.
 *
 * ?kind=... управляет ответом:
 *   - kind=brief (default)         — утренний экран: сегодня + ближайшая экадаши.
 *   - kind=upcoming                — ближайшая экадаши.
 *   - kind=today                   — события сегодня.
 *   - kind=month&year&month        — все события месяца.
 *   - kind=month-grid&year&month   — сетка дней с флагами (экадаши/праздник/точка/паран),
 *                                    + панчанга на каждый день.
 *   - kind=day&date=YYYY-MM-DD     — полный набор для дня (панчанга, астро, события, паран).
 *
 * ?location_id=...  — переопределить локацию (иначе берётся user_profile.current_location_id).
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
  const params = new URL(req.url).searchParams
  const kind = params.get('kind') || 'brief'
  const explicitLocId = params.get('location_id')

  // Локация: либо явно указанная (для смены города в календаре),
  // либо текущая из user_profile.
  type LocRow = { id: string; key: string; name: string; timezone: string; lat: number; lon: number }
  let loc: LocRow | null = null
  if (explicitLocId) {
    const { data, error } = await supabase
      .from('locations')
      .select('id, key, name, timezone, lat, lon')
      .eq('id', explicitLocId)
      .single()
    if (error || !data) return json({ error: 'location not found' }, 404)
    loc = data as LocRow
  } else {
    const { data: prof, error: profErr } = await supabase
      .from('user_profile')
      .select('current_location_id, locations:current_location_id(id, key, name, timezone, lat, lon)')
      .eq('id', user.id)
      .single()
    if (profErr || !prof) return json({ error: 'profile not found' }, 404)
    loc = prof.locations as LocRow | null
    if (!loc) return json({ error: 'no current location' }, 404)
  }

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
  if (kind === 'day') {
    const date = params.get('date') || today
    const [panchangaRes, eventsRes] = await Promise.all([
      supabase
        .from('vaishnava_panchanga')
        .select('*')
        .eq('user_id', user.id)
        .eq('location_id', loc.id)
        .eq('date', date)
        .maybeSingle(),
      supabase
        .from('vaishnava_calendar')
        .select('event_type, event_name, ekadashi_type, fasting_start_at, fasting_end_at, paran_start_at, paran_end_at, paran_type, description')
        .eq('user_id', user.id)
        .eq('location_id', loc.id)
        .eq('event_date', date)
        .order('event_type'),
    ])
    if (panchangaRes.error) return json({ error: panchangaRes.error.message }, 500)
    if (eventsRes.error) return json({ error: eventsRes.error.message }, 500)

    // Паран — если в этот день есть запись об экадаши с paran_start_at,
    // ИЛИ если предыдущий день — экадаши и его paran выпадает на этот день.
    let paran: { start_at: string; end_at: string | null } | null = null
    const events = eventsRes.data ?? []
    for (const ev of events) {
      if (ev.event_type === 'ekadashi' && ev.paran_start_at) {
        // на день самой экадаши паран ещё не наступил, он будет завтра
        paran = null
      }
    }
    // Ищем экадаши предыдущего дня, чей паран приходится на текущий
    const prevDate = new Date(date + 'T00:00:00Z')
    prevDate.setUTCDate(prevDate.getUTCDate() - 1)
    const prevIso = prevDate.toISOString().slice(0, 10)
    const { data: prevEk } = await supabase
      .from('vaishnava_calendar')
      .select('paran_start_at, paran_end_at')
      .eq('user_id', user.id)
      .eq('location_id', loc.id)
      .eq('event_date', prevIso)
      .eq('event_type', 'ekadashi')
      .maybeSingle()
    if (prevEk?.paran_start_at) {
      // Проверим что паран попадает в локальный день
      const paranLocalDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: loc.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(prevEk.paran_start_at))
      if (paranLocalDate === date) {
        paran = { start_at: prevEk.paran_start_at, end_at: prevEk.paran_end_at }
      }
    }

    return json({
      location: loc,
      date,
      panchanga: panchangaRes.data ?? null,
      events,
      paran,
    })
  }

  if (kind === 'month-grid') {
    const year = Number(params.get('year'))
    const month = Number(params.get('month'))
    if (!year || !month) return json({ error: 'year/month required' }, 400)
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
    const nextMonthStart = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`

    const [eventsRes, panchangaRes] = await Promise.all([
      supabase
        .from('vaishnava_calendar')
        .select('event_date, event_type, event_name, ekadashi_type')
        .eq('user_id', user.id)
        .eq('location_id', loc.id)
        .gte('event_date', monthStart)
        .lt('event_date', nextMonthStart),
      supabase
        .from('vaishnava_panchanga')
        .select('date, tithi_index, tithi_name, paksha, masa_name')
        .eq('user_id', user.id)
        .eq('location_id', loc.id)
        .gte('date', monthStart)
        .lt('date', nextMonthStart),
    ])
    if (eventsRes.error) return json({ error: eventsRes.error.message }, 500)
    if (panchangaRes.error) return json({ error: panchangaRes.error.message }, 500)

    // Сводим в day-map: date -> { flags, panchanga }
    const days: Record<string, {
      date: string,
      isEkadasi: boolean,
      isMajor: boolean,
      hasDot: boolean,
      eventNames: string[],
      panchanga: any,
    }> = {}

    // Известные большие праздники по названию — мажорные.
    const MAJOR_KEYWORDS = ['Джанмаштами', 'Гаура-пурнима', 'Нрисимха', 'Рама-навами', 'Радхаштами', 'Баларама-пурнима', 'Нитьянанда', 'Ратха-ятра', 'Говардхана', 'Гуру (Вьяса)']
    function isMajor(name: string): boolean {
      return MAJOR_KEYWORDS.some(k => name.includes(k))
    }

    for (const p of (panchangaRes.data ?? [])) {
      days[p.date] = {
        date: p.date,
        isEkadasi: false,
        isMajor: false,
        hasDot: false,
        eventNames: [],
        panchanga: p,
      }
    }
    for (const ev of (eventsRes.data ?? [])) {
      const d = ev.event_date
      if (!days[d]) {
        days[d] = { date: d, isEkadasi: false, isMajor: false, hasDot: false, eventNames: [], panchanga: null }
      }
      const slot = days[d]
      if (ev.event_type === 'ekadashi') slot.isEkadasi = true
      else if (isMajor(ev.event_name)) slot.isMajor = true
      else if (ev.event_type === 'appearance' || ev.event_type === 'disappearance') slot.hasDot = true
      slot.eventNames.push(ev.event_name)
    }

    return json({
      location: loc,
      year, month,
      days: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)),
    })
  }

  // kind=brief (default): сегодня + ближайшая экадаши + предыдущая (для yesterday-state) +
  // панчанга сегодня (для определения «вчера экадаши = сегодня двадаши»).
  const sevenAgo = (() => {
    const d = new Date(today + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() - 7)
    return d.toISOString().slice(0, 10)
  })()

  const [upcomingRes, prevRes, todayRes, panchangaRes] = await Promise.all([
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
      .select('event_date, event_name, paran_start_at, paran_end_at')
      .eq('user_id', user.id)
      .eq('location_id', loc.id)
      .eq('event_type', 'ekadashi')
      .gte('event_date', sevenAgo)
      .lt('event_date', today)
      .order('event_date', { ascending: false })
      .limit(1),
    supabase
      .from('vaishnava_calendar')
      .select('event_type, event_name, description')
      .eq('user_id', user.id)
      .eq('location_id', loc.id)
      .eq('event_date', today)
      .in('event_type', ['appearance', 'disappearance', 'purnima', 'amavasya', 'caturmasya_start', 'caturmasya_end']),
    supabase
      .from('vaishnava_panchanga')
      .select('tithi_name, tithi_index, paksha, masa_name, moon_illumination, moon_age_days')
      .eq('user_id', user.id)
      .eq('location_id', loc.id)
      .eq('date', today)
      .maybeSingle(),
  ])
  if (upcomingRes.error) return json({ error: upcomingRes.error.message }, 500)
  if (todayRes.error) return json({ error: todayRes.error.message }, 500)

  return json({
    location: loc,
    today,
    upcoming_ekadashi: upcomingRes.data?.[0] ?? null,
    prev_ekadashi: prevRes.data?.[0] ?? null,
    today_panchanga: panchangaRes.data ?? null,
    today_events: todayRes.data ?? [],
  })
})
