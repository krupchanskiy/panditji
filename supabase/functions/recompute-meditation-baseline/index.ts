/* Edge Function: recompute-meditation-baseline
 *
 * Recomputes all 8 baseline slots (4 periods × 2 calm_only) for one user and
 * upserts them into meditation_baseline. Called from:
 *   - compute-meditation-circles after a new session lands (async)
 *   - toggle-session-exclusion when a session's status changes
 *   - get-session-report / get-trends-report lazily when baseline is stale
 *
 * No cron — pull-when-needed (decision Q3 from planning).
 *
 * Auth: service-role bearer (caller is a server, not a browser).
 * Deploy: supabase functions deploy recompute-meditation-baseline --no-verify-jwt */

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { computeBaseline, SessionForBaseline } from './baseline.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const PERIODS = [
  { key: 'w', days: 7 },
  { key: 'm', days: 30 },
  { key: 'q', days: 90 },
  { key: 'all', days: null as number | null },
] as const

type Period = typeof PERIODS[number]['key']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!serviceKey || !supabaseUrl) return json({ error: 'server_misconfigured' }, 500)

  const providedKey = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (providedKey !== serviceKey) return json({ error: 'unauthorized' }, 401)

  let body: { user_id: string }
  try { body = await req.json() } catch { return json({ error: 'invalid_json' }, 400) }
  if (!body.user_id) return json({ error: 'missing_field' }, 400)

  const supabase = createClient(supabaseUrl, serviceKey)

  /* Load all of the user's sessions with eligible context. We don't pre-filter
   * by date — the same fetched set covers all four periods, just sliced later. */
  const { data: rows, error: sErr } = await supabase
    .from('meditation_sessions')
    .select(`
      id, started_at, duration_sec, circles,
      signal_quality_pct, signal_shift_severity, deepening_reliable,
      deepening_pct, ab_index_median, beta_median_rel,
      longest_calm_sec, calm_periods_count,
      duration_category, auto_tags, excluded_from_stats
    `)
    .eq('user_id', body.user_id)
    .order('started_at', { ascending: false })
  if (sErr) return json({ error: 'db_error', message: sErr.message }, 500)
  const sessionsList = rows ?? []

  /* Load per-circle data for sessions that have circles confirmed. */
  const eligibleIds = sessionsList
    .filter(s => s.circles !== null)
    .map(s => s.id)
  const circlesByOwner = new Map<string, {
    alpha: number[]; theta: number[]; beta: number[]; ab: number[]
  }>()
  if (eligibleIds.length > 0) {
    const { data: crows, error: cErr } = await supabase
      .from('meditation_circles')
      .select('session_id, circle_num, alpha_rel, theta_rel, beta_rel, ab_index')
      .in('session_id', eligibleIds)
      .order('circle_num', { ascending: true })
    if (cErr) return json({ error: 'db_error', message: cErr.message }, 500)
    for (const c of (crows ?? [])) {
      const sid = c.session_id as string
      let bag = circlesByOwner.get(sid)
      if (!bag) {
        bag = { alpha: [], theta: [], beta: [], ab: [] }
        circlesByOwner.set(sid, bag)
      }
      bag.alpha.push(c.alpha_rel as number)
      bag.theta.push(c.theta_rel as number)
      bag.beta.push(c.beta_rel as number)
      bag.ab.push(c.ab_index as number)
    }
  }

  /* Shape sessions for the pure recomputer. */
  const allSessions: (SessionForBaseline & { _startedAtMs: number })[] = sessionsList.map(s => ({
    id: s.id as string,
    duration_sec: s.duration_sec as number,
    circles: s.circles as number | null,
    signal_quality_pct: s.signal_quality_pct as number,
    signal_shift_severity: s.signal_shift_severity as 'medium' | 'high' | null,
    deepening_reliable: s.deepening_reliable as boolean | null,
    deepening_pct: s.deepening_pct as number | null,
    ab_index_median: s.ab_index_median as number,
    beta_median_rel: s.beta_median_rel as number,
    longest_calm_sec: s.longest_calm_sec as number | null,
    calm_periods_count: s.calm_periods_count as number | null,
    duration_category: s.duration_category as 'standard' | 'short' | 'long' | null,
    auto_tags: (s.auto_tags as string[]) ?? [],
    excluded_from_stats: s.excluded_from_stats as boolean,
    per_circle: circlesByOwner.get(s.id as string) ?? { alpha: [], theta: [], beta: [], ab: [] },
    _startedAtMs: Date.parse(s.started_at as string),
  }))

  /* For each (period × calm_only), filter by date, compute baseline, upsert. */
  const now = Date.now()
  const summary: Array<{ period: Period; calm_only: boolean; session_count: number }> = []

  for (const p of PERIODS) {
    const cutoff = p.days === null ? 0 : now - p.days * 24 * 60 * 60 * 1000
    const inPeriod = allSessions.filter(s => s._startedAtMs >= cutoff)

    for (const calmOnly of [false, true]) {
      const baseline = computeBaseline(inPeriod, calmOnly)

      const payload = {
        user_id: body.user_id,
        period: p.key,
        calm_only: calmOnly,
        session_count: baseline.session_count,
        avg_deepening: baseline.avg_deepening,
        avg_stability: baseline.avg_stability,
        avg_beta: baseline.avg_beta,
        avg_longest_calm_sec: baseline.avg_longest_calm_sec,
        avg_calm_periods_count: baseline.avg_calm_periods_count,
        avg_alpha_normalized: baseline.avg_alpha_normalized,
        avg_theta_normalized: baseline.avg_theta_normalized,
        avg_beta_normalized: baseline.avg_beta_normalized,
        avg_ab_normalized: baseline.avg_ab_normalized,
        computed_at: new Date(now).toISOString(),
      }

      const { error: upErr } = await supabase
        .from('meditation_baseline')
        .upsert(payload, { onConflict: 'user_id,period,calm_only' })
      if (upErr) return json({ error: 'db_upsert_failed', message: upErr.message }, 500)

      summary.push({ period: p.key, calm_only: calmOnly, session_count: baseline.session_count })
    }
  }

  return json({ user_id: body.user_id, recomputed: summary })
})
