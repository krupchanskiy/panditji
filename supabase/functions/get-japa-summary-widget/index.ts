/* Edge Function: get-japa-summary-widget
 *
 * Compact summary of the user's most recent meditation session, for the morning
 * dashboard widget. See japa-widget-addendum.md for the data contract.
 *
 * States (added pending_context to the original spec — if the latest session
 * has no confirmed circles yet, we surface it so the user knows it's waiting):
 *   no_sessions     — nothing in the DB (or only stale unconfirmed ones)
 *   pending_context — fresh session uploaded but circles not yet confirmed
 *   stale           — last completed session is >24h old
 *   fresh           — last completed session is <24h, metrics filled when baseline ready
 *
 * Auth: user JWT (verify_jwt: true). RLS limits to current user.
 * Deploy: supabase functions deploy get-japa-summary-widget */

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const FRESH_HOURS = 24
const PENDING_MAX_HOURS = 48
const BASELINE_MIN_SESSIONS = 5

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)

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

  /* Latest session — could have circles=null (pending) or circles confirmed. */
  const { data: latest, error: lErr } = await supabase
    .from('meditation_sessions')
    .select(`
      id, started_at, ended_at, duration_sec, circles, pace_min_per_circle,
      session_kind, excluded_from_stats, excluded_reason, duration_category,
      deepening_pct, deepening_reliable, ab_index_median, longest_calm_sec
    `)
    .eq('user_id', user.id)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lErr) return json({ error: 'db_error', message: lErr.message }, 500)

  if (!latest) return empty('no_sessions')

  const ageHours = (Date.now() - Date.parse(latest.ended_at)) / 3600_000

  /* Pending — uploaded but circles not confirmed. */
  if (latest.circles === null) {
    if (ageHours > PENDING_MAX_HOURS) return empty('no_sessions')
    return json({
      state: 'pending_context',
      session: {
        id: latest.id,
        date: friendlyDate(latest.started_at),
        durationMin: round1(latest.duration_sec / 60),
        circles: null,
        ageHours: round1(ageHours),
      },
      metrics: null,
      noCompareReason: null,
      baselineSessionCount: 0,
    })
  }

  /* Older than 24h — just point at the last completed session, no live metrics. */
  if (ageHours > FRESH_HOURS) {
    return json({
      state: 'stale',
      session: {
        id: latest.id,
        date: friendlyDate(latest.started_at),
        durationMin: round1(latest.duration_sec / 60),
        circles: latest.circles,
        ageHours: round1(ageHours),
      },
      metrics: null,
      noCompareReason: null,
      baselineSessionCount: 0,
    })
  }

  /* Fresh: decide whether comparisons are possible. */
  type BaselineRow = {
    session_count: number
    avg_deepening: number | null
    avg_stability: number | null
    avg_longest_calm_sec: number | null
  }
  let noCompareReason: string | null = null
  let baseline: BaselineRow | null = null

  if (latest.excluded_from_stats) {
    noCompareReason = latest.excluded_reason === 'preview' ? 'preview' : 'manual_exclude'
  } else if (latest.duration_category === 'short' || latest.duration_category === 'long') {
    noCompareReason = 'nonstandard_duration'
  } else {
    /* Load 30-day calm-only baseline. */
    const { data: row } = await supabase
      .from('meditation_baseline')
      .select('session_count, avg_deepening, avg_stability, avg_longest_calm_sec')
      .eq('user_id', user.id)
      .eq('period', 'm')
      .eq('calm_only', true)
      .maybeSingle()
    baseline = row as BaselineRow | null
    if (!baseline || baseline.session_count < BASELINE_MIN_SESSIONS) {
      noCompareReason = 'no_baseline'
    }
  }

  const sessionPayload = {
    id: latest.id,
    date: friendlyDate(latest.started_at),
    durationMin: round1(latest.duration_sec / 60),
    circles: latest.circles,
    ageHours: round1(ageHours),
  }

  if (noCompareReason !== null) {
    return json({
      state: 'fresh',
      session: sessionPayload,
      metrics: null,
      noCompareReason,
      baselineSessionCount: baseline?.session_count ?? 0,
    })
  }

  /* Build metrics with deltas. */
  const todayDeep = latest.deepening_reliable ? latest.deepening_pct : null
  const todayStab = latest.ab_index_median
  const todayCalm = latest.longest_calm_sec ?? 0

  return json({
    state: 'fresh',
    session: sessionPayload,
    metrics: {
      deepening: makeMetric(todayDeep, baseline!.avg_deepening),
      stability: makeMetric(todayStab, baseline!.avg_stability),
      longestCalm: makeMetric(todayCalm, baseline!.avg_longest_calm_sec, 'sec'),
    },
    noCompareReason: null,
    baselineSessionCount: baseline!.session_count,
  })
})

function makeMetric(today: number | null, baseline: number | null, unit?: 'sec') {
  if (today === null || baseline === null) {
    return { today, baseline, deltaPct: null, unit }
  }
  const deltaPct = baseline !== 0 ? ((today - baseline) / baseline) * 100 : 0
  return { today: round2(today), baseline: round2(baseline), deltaPct: round1(deltaPct), unit }
}

function empty(state: 'no_sessions') {
  return json({
    state,
    session: null,
    metrics: null,
    noCompareReason: null,
    baselineSessionCount: 0,
  })
}

function friendlyDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate()
  if (sameDay(d, now)) return 'сегодня'
  const yesterday = new Date(now); yesterday.setUTCDate(now.getUTCDate() - 1)
  if (sameDay(d, yesterday)) return 'вчера'
  return `${d.getUTCDate()} ${monthRu(d.getUTCMonth())}`
}

function monthRu(m: number): string {
  return ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][m]
}

function round1(v: number): number { return Math.round(v * 10) / 10 }
function round2(v: number): number { return Math.round(v * 100) / 100 }
