/* Edge Function: get-trends-report
 *
 * Returns TrendsReport for the PWA stats screen.
 *
 * Auth: user JWT (verify_jwt: true). RLS filters sessions to current user.
 * Deploy: supabase functions deploy get-trends-report
 *
 * Query params:
 *   period:    7 | 30 | 90 | 365         default 30
 *   calm_only: true | false              default true
 *
 * avgCalmNormalized / avgAllNormalized / correlations are null at this point —
 * they fill in once recompute-baseline + correlations blocks land. */

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { buildTrendsReport, SessionForTrends } from './trends.ts'

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

const VALID_PERIODS = new Set([7, 30, 90, 365])
const DEFAULT_PERIOD = 30

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)

  const url = new URL(req.url)
  const periodRaw = parseInt(url.searchParams.get('period') ?? '', 10)
  const period = VALID_PERIODS.has(periodRaw) ? periodRaw : DEFAULT_PERIOD
  const calmOnly = (url.searchParams.get('calm_only') ?? 'true') === 'true'

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) return json({ error: 'server_misconfigured' }, 500)

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthorized' }, 401)
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  })

  const sinceIso = new Date(Date.now() - period * 24 * 60 * 60 * 1000).toISOString()

  /* Load sessions with location joined. RLS filters to current user automatically. */
  const { data, error } = await supabase
    .from('meditation_sessions')
    .select(`
      id, started_at, duration_sec, circles, pace_min_per_circle,
      signal_quality_pct, signal_shift_severity, deepening_reliable,
      deepening_pct, ab_index_median, longest_calm_sec,
      duration_category, whoop_sleep_hours, whoop_recovery_pct,
      distracted, self_rating, auto_tags, excluded_from_stats,
      location:locations ( name )
    `)
    .gte('started_at', sinceIso)
    .order('started_at', { ascending: true })
  if (error) return json({ error: 'db_error', message: error.message }, 500)

  /* Supabase returns the joined location as either an object or null
   * depending on the FK cardinality. Flatten for downstream. */
  const sessions: SessionForTrends[] = (data ?? []).map((row: Record<string, unknown>) => {
    const loc = row.location as { name: string } | null
    const { location: _ignore, ...rest } = row
    return {
      ...rest,
      location_name: loc?.name ?? null,
    } as SessionForTrends
  })

  const report = buildTrendsReport({
    period, calmOnly, now: new Date(), sessions,
  })
  return json(report)
})
