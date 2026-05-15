/* Edge Function: get-session-report
 *
 * Returns SessionReport for the PWA session screen.
 *
 * Auth: user JWT (verify_jwt: true at deploy). RLS enforces that user sees only own session.
 * Deploy: supabase functions deploy get-session-report
 *
 * Baseline comparisons (compare.*.periods) are wired in the SessionReport shape
 * but always null at this point — recompute-meditation-baseline lands in the
 * next block, after which periods get populated. */

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { buildSessionReport, SessionRow, CircleRow, LocationRow } from './report.ts'

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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) return json({ error: 'server_misconfigured' }, 500)

  /* Run under the user's JWT so RLS filters automatically. */
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthorized' }, 401)
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  })

  /* Session row. RLS guarantees user_id = auth.uid(); .single() returns error if missing. */
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

  /* Circles (may be empty if user hasn't confirmed circles yet). */
  const { data: circleRows, error: cErr } = await supabase
    .from('meditation_circles')
    .select('circle_num, alpha_rel, theta_rel, beta_rel, ab_index')
    .eq('session_id', sessionId)
    .order('circle_num')
  if (cErr) return json({ error: 'db_error', message: cErr.message }, 500)

  /* Location — optional. Skip query when session.location_id is null. */
  let location: LocationRow | null = null
  if (session.location_id) {
    const { data: loc } = await supabase
      .from('locations')
      .select('id, name')
      .eq('id', session.location_id)
      .maybeSingle()
    location = loc as LocationRow | null
  }

  const report = buildSessionReport(
    session as unknown as SessionRow,
    (circleRows ?? []) as unknown as CircleRow[],
    location,
  )
  return json(report)
})
