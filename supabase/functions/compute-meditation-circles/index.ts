/* Edge Function: compute-meditation-circles
 *
 * Called by telegram-webhook after user confirms `circles` count.
 * Loads the already-parsed session, splits its timeline into N circles,
 * computes deepening / longest_calm / duration_category, auto-tags it,
 * generates interpretations, and writes everything back.
 *
 * Idempotent: deletes existing meditation_circles rows for the session before
 * inserting new ones, then overwrites derived fields on meditation_sessions.
 * Re-running with different `circles` re-splits.
 *
 * Auth: service-role key (caller is the bot).
 * Deploy: supabase functions deploy compute-meditation-circles --no-verify-jwt */

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { computeCircles } from './compute.ts'
import { computeAutoTags } from './tags.ts'
import type { SessionForTags } from './tags.ts'
import {
  generateMainCaption, generateCalmCaption, INTERPRETATION_VERSION,
  SessionForInterpretation,
} from './interpretations.ts'
import { detectPhases } from './phases.ts'

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

type ComputeRequest = {
  user_id: string
  session_id: string
  circles: number
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) return json({ error: 'server_misconfigured' }, 500)

  const providedKey = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (providedKey !== serviceKey) return json({ error: 'unauthorized' }, 401)

  let body: ComputeRequest
  try {
    body = await req.json() as ComputeRequest
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  if (!body.user_id || !body.session_id || !body.circles || body.circles < 1) {
    return json({ error: 'missing_or_invalid_field' }, 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) return json({ error: 'server_misconfigured' }, 500)
  const supabase = createClient(supabaseUrl, serviceKey)

  /* Load the session row — must already have timeline_30s from parse step. */
  const { data: session, error: sErr } = await supabase
    .from('meditation_sessions')
    .select(`
      id, user_id, duration_sec, signal_quality_pct, headband_on_pct,
      signal_shift_at_sec, signal_shift_severity,
      theta_first_third, theta_last_third,
      alpha_first_third, alpha_last_third, alpha_median_rel,
      delta_first_third, delta_last_third,
      hr_first_third, hr_last_third,
      timeline_30s
    `)
    .eq('id', body.session_id)
    .eq('user_id', body.user_id)
    .single()
  if (sErr || !session) {
    return json({ error: 'session_not_found', message: sErr?.message }, 404)
  }
  if (!session.timeline_30s) {
    return json({ error: 'session_not_parsed', message: 'timeline_30s missing — run parse-meditation-csv first' }, 400)
  }

  /* Personal duration history for category classification — last 30 days,
   * regular sessions only, with circles confirmed, excluding this session. */
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: durRows } = await supabase
    .from('meditation_sessions')
    .select('duration_sec')
    .eq('user_id', body.user_id)
    .eq('session_kind', 'regular')
    .eq('excluded_from_stats', false)
    .not('circles', 'is', null)
    .neq('id', body.session_id)
    .gte('started_at', thirtyDaysAgo)
  const recentRegularDurations = (durRows ?? []).map(r => r.duration_sec as number)

  /* Compute derived metrics. */
  const result = computeCircles({
    durationSec: session.duration_sec,
    thetaFirstThird: session.theta_first_third,
    thetaLastThird: session.theta_last_third,
    signalShiftAtSec: session.signal_shift_at_sec,
    timeline30s: session.timeline_30s,
    circlesCount: body.circles,
    recentRegularDurations,
  })

  /* Tags depend on computed metrics. */
  const tagInput: SessionForTags = {
    signalShiftSeverity: session.signal_shift_severity,
    deepeningReliable: result.deepeningReliable,
    deepeningPct: result.deepeningPct,
    thetaFirstThird: session.theta_first_third,
    thetaLastThird: session.theta_last_third,
    deltaFirstThird: session.delta_first_third,
    deltaLastThird: session.delta_last_third,
    hrFirstThird: session.hr_first_third,
    hrLastThird: session.hr_last_third,
    signalQualityPct: session.signal_quality_pct,
    headbandOnPct: session.headband_on_pct,
    durationCategory: result.durationCategory,
  }
  const autoTags = computeAutoTags(tagInput, result.circles)

  /* Interpretations consume tags (for drowsiness branch). */
  const interpInput: SessionForInterpretation = {
    signalShiftSeverity: session.signal_shift_severity,
    signalShiftAtSec: session.signal_shift_at_sec,
    deepeningReliable: result.deepeningReliable,
    deepeningPct: result.deepeningPct,
    thetaFirstThird: session.theta_first_third,
    thetaLastThird: session.theta_last_third,
    alphaFirstThird: session.alpha_first_third,
    alphaLastThird: session.alpha_last_third,
    alphaMedianRel: session.alpha_median_rel,
    autoTags,
  }
  const main = generateMainCaption(interpInput, result.circles)
  const calm = generateCalmCaption(
    result.longestCalmSec, result.longestCalmAtSec, result.paceMinPerCircle,
  )
  const phases = detectPhases(interpInput, result.circles)

  /* Re-split: replace any existing circles atomically. */
  const { error: delErr } = await supabase
    .from('meditation_circles')
    .delete()
    .eq('session_id', body.session_id)
  if (delErr) return json({ error: 'db_delete_circles_failed', message: delErr.message }, 500)

  if (result.circles.length > 0) {
    const circleRows = result.circles.map(c => ({ ...c, session_id: body.session_id }))
    const { error: insErr } = await supabase.from('meditation_circles').insert(circleRows)
    if (insErr) return json({ error: 'db_insert_circles_failed', message: insErr.message }, 500)
  }

  const { error: updErr } = await supabase
    .from('meditation_sessions')
    .update({
      circles: body.circles,
      pace_min_per_circle: result.paceMinPerCircle,
      deepening_pct: result.deepeningPct,
      deepening_reliable: result.deepeningReliable,
      longest_calm_sec: result.longestCalmSec,
      longest_calm_at_sec: result.longestCalmAtSec,
      calm_periods_count: result.calmPeriodsCount,
      duration_category: result.durationCategory,
      duration_vs_median_pct: result.durationVsMedianPct,
      auto_tags: autoTags,
      interpretations: { main, calm, phases },
      interpretation_version: INTERPRETATION_VERSION,
    })
    .eq('id', body.session_id)
    .eq('user_id', body.user_id)
  if (updErr) return json({ error: 'db_update_session_failed', message: updErr.message }, 500)

  /* Trigger baseline recompute (ТЗ step 9). Non-fatal: if it fails, the lazy
   * recompute in get-session-report / get-trends-report will catch up. */
  try {
    await triggerRecompute(body.user_id)
  } catch (e) {
    console.error('recompute trigger failed (non-fatal):', e)
  }

  return json({
    session_id: body.session_id,
    pace_min_per_circle: result.paceMinPerCircle,
    deepening_pct: result.deepeningPct,
    deepening_reliable: result.deepeningReliable,
    longest_calm_sec: result.longestCalmSec,
    calm_periods_count: result.calmPeriodsCount,
    duration_category: result.durationCategory,
    auto_tags: autoTags,
    caption_main: main,
    caption_calm: calm,
  })
})

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
