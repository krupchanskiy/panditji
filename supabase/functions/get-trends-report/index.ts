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

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { buildTrendsReport, NormalizedBaseline, SessionForTrends } from './trends.ts'

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

  /* Per-position normalized averages live in meditation_baseline. We need both
   * calm-only and all variants for the same period. Lazy-recompute if stale. */
  let avgCalmNormalized: NormalizedBaseline | null = null
  let avgAllNormalized: NormalizedBaseline | null = null
  if (sessions.length > 0) {
    try {
      const userId = await getUserIdFromAuth(supabase)
      if (userId) {
        const periodKey = periodDaysToKey(period)
        const baselines = await loadBaselinesWithLazyRecompute(supabase, userId, periodKey)
        avgCalmNormalized = baselines.calm
        avgAllNormalized = baselines.all
      }
    } catch (e) {
      console.error('baseline load failed, continuing without:', e)
    }
  }

  const report = buildTrendsReport({
    period, calmOnly, now: new Date(), sessions,
    avgCalmNormalized, avgAllNormalized,
  })
  return json(report)
})

type PeriodKey = 'w' | 'm' | 'q' | 'all'

function periodDaysToKey(days: number): PeriodKey {
  if (days <= 7) return 'w'
  if (days <= 30) return 'm'
  if (days <= 90) return 'q'
  return 'all'
}

async function getUserIdFromAuth(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null
  return data.user.id
}

async function loadBaselinesWithLazyRecompute(
  supabase: SupabaseClient, userId: string, period: PeriodKey,
): Promise<{ calm: NormalizedBaseline | null; all: NormalizedBaseline | null }> {
  let rows = await fetchBaselinesForPeriod(supabase, userId, period)

  if (await needsRecompute(supabase, userId, rows)) {
    await triggerRecompute(userId)
    rows = await fetchBaselinesForPeriod(supabase, userId, period)
  }

  return {
    calm: pickNormalized(rows, true),
    all: pickNormalized(rows, false),
  }
}

type RawRow = {
  calm_only: boolean
  session_count: number
  computed_at: string
  avg_alpha_normalized: number[] | null
  avg_theta_normalized: number[] | null
  avg_beta_normalized: number[] | null
  avg_ab_normalized: number[] | null
}

async function fetchBaselinesForPeriod(
  supabase: SupabaseClient, userId: string, period: PeriodKey,
): Promise<RawRow[]> {
  const { data, error } = await supabase
    .from('meditation_baseline')
    .select(`
      calm_only, session_count, computed_at,
      avg_alpha_normalized, avg_theta_normalized,
      avg_beta_normalized, avg_ab_normalized
    `)
    .eq('user_id', userId)
    .eq('period', period)
  if (error) throw error
  return (data ?? []) as unknown as RawRow[]
}

async function needsRecompute(
  supabase: SupabaseClient, userId: string, rows: RawRow[],
): Promise<boolean> {
  // We expect both calm_only variants — missing either means recompute.
  const haveCalm = rows.some(r => r.calm_only === true)
  const haveAll  = rows.some(r => r.calm_only === false)
  if (!haveCalm || !haveAll) return true

  const oldest = Math.min(...rows.map(r => Date.parse(r.computed_at)))

  const { data: latest } = await supabase
    .from('meditation_sessions')
    .select('started_at')
    .eq('user_id', userId)
    .eq('excluded_from_stats', false)
    .not('circles', 'is', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!latest) return false
  return Date.parse(latest.started_at) > oldest
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

function pickNormalized(rows: RawRow[], calmOnly: boolean): NormalizedBaseline | null {
  const r = rows.find(x => x.calm_only === calmOnly)
  if (!r) return null
  // Need ≥1 of the four arrays present; we'll let buildTrendsReport pass them through.
  return {
    alpha: r.avg_alpha_normalized,
    theta: r.avg_theta_normalized,
    beta: r.avg_beta_normalized,
    ab: r.avg_ab_normalized,
  }
}
