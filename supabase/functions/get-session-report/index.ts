/* Edge Function: get-session-report
 *
 * Returns SessionReport for the PWA session screen, including baseline-backed
 * compare.*.periods when a fresh baseline exists.
 *
 * Lazy recompute (Q3 decision, no cron):
 *   - If any baseline row for the user is missing OR predates the user's
 *     latest session — call recompute-meditation-baseline once, then re-fetch.
 *   - On recompute error: log + continue with whatever rows we have, so the
 *     screen still renders.
 *
 * Auth: user JWT (verify_jwt: true). RLS filters sessions/baselines to current user.
 * Deploy: supabase functions deploy get-session-report
 *
 * Query: ?id=<session_id>&calm_only=true|false  (default calm_only=true) */

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import {
  buildSessionReport, SessionRow, CircleRow, LocationRow,
  BaselineRow, BaselinesByPeriod,
} from './report.ts'
import { resampleFromBins } from '../recompute-meditation-baseline/resample.ts'

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)

  const url = new URL(req.url)
  const sessionId = url.searchParams.get('id')
  if (!sessionId) return json({ error: 'missing_id', message: 'query param "id" required' }, 400)
  const calmOnly = (url.searchParams.get('calm_only') ?? 'true') === 'true'

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) return json({ error: 'server_misconfigured' }, 500)

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthorized' }, 401)
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  })

  /* Session row. */
  const { data: session, error: sErr } = await supabase
    .from('meditation_sessions')
    .select(`
      id, user_id, started_at, ended_at, duration_sec, location_id,
      session_kind, excluded_from_stats, excluded_reason,
      circles, pace_min_per_circle,
      signal_quality_pct, artifacts_level, electrodes_status, headband_on_pct,
      signal_shift_at_sec, signal_shift_severity, deepening_reliable,
      distracted, self_rating, user_note,
      whoop_sleep_hours, whoop_recovery_pct,
      ab_index_median, beta_median_rel,
      deepening_pct, longest_calm_sec, longest_calm_at_sec, calm_periods_count,
      duration_category, duration_vs_median_pct,
      auto_tags, interpretations
    `)
    .eq('id', sessionId)
    .maybeSingle()
  if (sErr) return json({ error: 'db_error', message: sErr.message }, 500)
  if (!session) return json({ error: 'not_found' }, 404)

  /* Circles. */
  const { data: circleRows, error: cErr } = await supabase
    .from('meditation_circles')
    .select('circle_num, alpha_rel, theta_rel, beta_rel, ab_index')
    .eq('session_id', sessionId)
    .order('circle_num')
  if (cErr) return json({ error: 'db_error', message: cErr.message }, 500)

  /* Location. */
  let location: LocationRow | null = null
  if (session.location_id) {
    const { data: loc } = await supabase
      .from('locations')
      .select('id, name')
      .eq('id', session.location_id)
      .maybeSingle()
    location = loc as LocationRow | null
  }

  /* Baselines (lazy recompute). Failures degrade gracefully — we still render the page. */
  let baselines: BaselinesByPeriod | null = null
  try {
    baselines = await loadBaselinesWithLazyRecompute(
      supabase, session.user_id as string, calmOnly,
    )
  } catch (e) {
    console.error('baseline load failed, continuing without:', e)
  }

  const report = buildSessionReport(
    session as unknown as SessionRow,
    (circleRows ?? []) as unknown as CircleRow[],
    location,
    baselines,
    resampleFromBins,
  )
  return json(report)
})

async function loadBaselinesWithLazyRecompute(
  supabase: SupabaseClient, userId: string, calmOnly: boolean,
): Promise<BaselinesByPeriod> {
  let rows = await fetchBaselines(supabase, userId, calmOnly)

  if (await needsRecompute(supabase, userId, rows)) {
    await triggerRecompute(userId)
    rows = await fetchBaselines(supabase, userId, calmOnly)
  }

  return rowsToByPeriod(rows)
}

type RawBaselineRow = BaselineRow & { period: 'w' | 'm' | 'q' | 'all'; computed_at: string }

async function fetchBaselines(
  supabase: SupabaseClient, userId: string, calmOnly: boolean,
): Promise<RawBaselineRow[]> {
  const { data, error } = await supabase
    .from('meditation_baseline')
    .select(`
      period, session_count, computed_at,
      avg_deepening, avg_stability, avg_beta,
      avg_theta_normalized, avg_ab_normalized, avg_beta_normalized
    `)
    .eq('user_id', userId)
    .eq('calm_only', calmOnly)
  if (error) throw error
  return (data ?? []) as unknown as RawBaselineRow[]
}

async function needsRecompute(
  supabase: SupabaseClient, userId: string, rows: RawBaselineRow[],
): Promise<boolean> {
  if (rows.length === 0) return true
  const oldestComputed = Math.min(...rows.map(r => Date.parse(r.computed_at)))

  const { data: latest } = await supabase
    .from('meditation_sessions')
    .select('started_at')
    .eq('user_id', userId)
    .eq('excluded_from_stats', false)
    .not('circles', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!latest) return false        // user has no eligible sessions — nothing to recompute against
  return Date.parse(latest.started_at) > oldestComputed
}

async function triggerRecompute(userId: string): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing for recompute trigger')
  const resp = await fetch(`${url}/functions/v1/recompute-meditation-baseline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ user_id: userId }),
  })
  if (!resp.ok) throw new Error(`recompute returned ${resp.status}: ${await resp.text()}`)
}

function rowsToByPeriod(rows: RawBaselineRow[]): BaselinesByPeriod {
  const out: BaselinesByPeriod = { w: null, m: null, q: null, all: null }
  for (const r of rows) {
    out[r.period] = {
      session_count: r.session_count,
      avg_deepening: r.avg_deepening,
      avg_stability: r.avg_stability,
      avg_beta: r.avg_beta,
      avg_theta_normalized: r.avg_theta_normalized,
      avg_ab_normalized: r.avg_ab_normalized,
      avg_beta_normalized: r.avg_beta_normalized,
    }
  }
  return out
}
