/* Edge Function: enrich-meditation-with-whoop
 *
 * Attaches Whoop context (sleep hours from the prior night, recovery score for the day)
 * to meditation_sessions. Two modes:
 *
 *   POST { session_id }            — enrich one session (fired async from compute-meditation-circles)
 *   POST {} or POST { sweep:true } — sweep mode: enrich all sessions where
 *                                    whoop_enriched_at IS NULL AND started_at >= now() - 7 days
 *                                    Intended for a periodic call (cron).
 *
 * Rule: even when Whoop data isn't found, we set whoop_enriched_at = now() so we
 * don't retry forever. After the 7-day window, sweep stops looking — user probably
 * forgot to sync Whoop, no point spinning on it.
 *
 * Auth: service-role bearer.
 * Deploy: supabase functions deploy enrich-meditation-with-whoop --no-verify-jwt */

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

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

const SLEEP_LOOKBACK_HOURS = 12              // sleep must end ≤12h before the session start
const SWEEP_WINDOW_DAYS = 7

type EnrichRequest = {
  session_id?: string
  sweep?: boolean
}

type SessionForEnrich = {
  id: string
  user_id: string
  started_at: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!serviceKey || !supabaseUrl) return json({ error: 'server_misconfigured' }, 500)

  const providedKey = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (providedKey !== serviceKey) return json({ error: 'unauthorized' }, 401)

  let body: EnrichRequest = {}
  try { body = await req.json() } catch {
    // Empty body is fine — defaults to sweep.
  }

  const supabase = createClient(supabaseUrl, serviceKey)

  /* Single-session mode. */
  if (body.session_id) {
    const { data: session, error: sErr } = await supabase
      .from('meditation_sessions')
      .select('id, user_id, started_at')
      .eq('id', body.session_id)
      .maybeSingle()
    if (sErr) return json({ error: 'db_error', message: sErr.message }, 500)
    if (!session) return json({ error: 'not_found' }, 404)

    const result = await enrichOne(supabase, session as SessionForEnrich)
    return json({ session_id: session.id, ...result })
  }

  /* Sweep mode. */
  const cutoff = new Date(Date.now() - SWEEP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data: pending, error: pErr } = await supabase
    .from('meditation_sessions')
    .select('id, user_id, started_at')
    .is('whoop_enriched_at', null)
    .gte('started_at', cutoff)
    .order('started_at', { ascending: false })
    .limit(50)            // safety cap; cron runs hourly, plenty of headroom
  if (pErr) return json({ error: 'db_error', message: pErr.message }, 500)

  let enrichedCount = 0
  for (const s of (pending ?? []) as SessionForEnrich[]) {
    try {
      const r = await enrichOne(supabase, s)
      if (r.whoop_sleep_hours !== null || r.whoop_recovery_pct !== null) enrichedCount++
    } catch (e) {
      console.error(`enrich failed for ${s.id}:`, e)
    }
  }

  return json({ swept: pending?.length ?? 0, enriched_with_data: enrichedCount })
})

async function enrichOne(supabase: SupabaseClient, session: SessionForEnrich): Promise<{
  whoop_sleep_hours: number | null
  whoop_recovery_pct: number | null
}> {
  const startMs = Date.parse(session.started_at)
  const sleepCutoffIso = new Date(startMs - SLEEP_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()
  const sessionDate = session.started_at.slice(0, 10)   // YYYY-MM-DD (UTC)

  /* Prior-night sleep: the most recent record ending in [sleepCutoff, session start]. */
  const { data: sleep, error: slErr } = await supabase
    .from('whoop_sleeps')
    .select('duration_seconds')
    .eq('user_id', session.user_id)
    .gte('end_at', sleepCutoffIso)
    .lte('end_at', session.started_at)
    .order('end_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (slErr) throw slErr

  /* Recovery score for that calendar day (Whoop posts one per date). */
  const { data: recovery, error: rcErr } = await supabase
    .from('whoop_recovery')
    .select('recovery_score')
    .eq('user_id', session.user_id)
    .eq('date', sessionDate)
    .maybeSingle()
  if (rcErr) throw rcErr

  const whoopSleepHours = sleep ? round2(sleep.duration_seconds / 3600) : null
  const whoopRecoveryPct = recovery ? recovery.recovery_score : null

  const { error: uErr } = await supabase
    .from('meditation_sessions')
    .update({
      whoop_sleep_hours: whoopSleepHours,
      whoop_recovery_pct: whoopRecoveryPct,
      whoop_enriched_at: new Date().toISOString(),
    })
    .eq('id', session.id)
  if (uErr) throw uErr

  return { whoop_sleep_hours: whoopSleepHours, whoop_recovery_pct: whoopRecoveryPct }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
