/* Edge Function: parse-meditation-csv
 *
 * Called by telegram-webhook after CSV upload to Storage. Downloads gzipped CSV,
 * parses it into session aggregates, upserts into meditation_sessions.
 *
 * Does NOT split into circles or compute deepening/longest_calm — that happens
 * in compute-meditation-circles after user confirms circles count in the bot.
 *
 * Auth: service-role key in Authorization header (no JWT — caller is the bot).
 * Deploy: supabase functions deploy parse-meditation-csv --no-verify-jwt
 *
 * Idempotent: bot generates session_id before upload, upsert (ON CONFLICT id)
 * means re-running on the same input produces the same DB state. */

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { parseMindMonitorCSV, ParseError, SessionAggregates } from './parser.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

type ParseRequest = {
  user_id: string
  session_id: string
  storage_path: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  /* Auth: bot passes service-role key. We don't trust verify_jwt: false to mean "anyone";
   * we re-check the secret here. */
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) return json({ error: 'server_misconfigured' }, 500)

  const authHeader = req.headers.get('Authorization') ?? ''
  const providedKey = authHeader.replace(/^Bearer\s+/i, '')
  if (providedKey !== serviceKey) {
    return json({ error: 'unauthorized' }, 401)
  }

  let body: ParseRequest
  try {
    body = await req.json() as ParseRequest
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  if (!body.user_id || !body.session_id || !body.storage_path) {
    return json({ error: 'missing_field', message: 'user_id, session_id, storage_path are required' }, 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) return json({ error: 'server_misconfigured' }, 500)
  const supabase = createClient(supabaseUrl, serviceKey)

  /* Download gzip CSV from Storage. */
  const { data: blob, error: dlErr } = await supabase.storage
    .from('meditation-csv')
    .download(body.storage_path)
  if (dlErr || !blob) {
    return json({ error: 'storage_download_failed', message: dlErr?.message ?? 'no blob' }, 500)
  }

  const csvSizeBytes = blob.size

  /* Decompress gzip → text. DecompressionStream is web standard, works in Deno. */
  let csvText: string
  try {
    const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'))
    csvText = await new Response(stream).text()
  } catch (e) {
    return json({ error: 'decompress_failed', message: String(e) }, 500)
  }

  /* Parse. */
  let aggregates: SessionAggregates
  try {
    aggregates = parseMindMonitorCSV(csvText)
  } catch (e) {
    if (e instanceof ParseError) {
      return json({ error: 'parse_failed', code: e.code, message: e.message }, 400)
    }
    return json({ error: 'parse_failed', message: String(e) }, 500)
  }

  /* Upsert into meditation_sessions. session_id is the conflict key — bot generates it
   * before uploading the CSV, so re-runs land on the same row. */
  const payload = {
    id: body.session_id,
    user_id: body.user_id,
    source: 'mind_monitor',

    started_at: aggregates.startedAt,
    ended_at: aggregates.endedAt,
    duration_sec: aggregates.durationSec,

    signal_quality_pct: aggregates.signalQualityPct,
    artifacts_level: aggregates.artifactsLevel,
    electrodes_status: aggregates.electrodesStatus,
    headband_on_pct: aggregates.headbandOnPct,

    signal_shift_at_sec: aggregates.signalShiftAtSec,
    signal_shift_severity: aggregates.signalShiftSeverity,

    alpha_median_rel: aggregates.alphaMedianRel,
    theta_median_rel: aggregates.thetaMedianRel,
    beta_median_rel: aggregates.betaMedianRel,
    gamma_median_rel: aggregates.gammaMedianRel,
    delta_median_rel: aggregates.deltaMedianRel,
    ab_index_median: aggregates.abIndexMedian,
    tb_index_median: aggregates.tbIndexMedian,

    alpha_first_third: aggregates.alphaFirstThird,
    alpha_last_third: aggregates.alphaLastThird,
    theta_first_third: aggregates.thetaFirstThird,
    theta_last_third: aggregates.thetaLastThird,
    delta_first_third: aggregates.deltaFirstThird,
    delta_last_third: aggregates.deltaLastThird,

    hr_first_third: aggregates.hrFirstThird,
    hr_last_third: aggregates.hrLastThird,
    hr_median: aggregates.hrMedian,

    timeline_30s: aggregates.timeline30s,
    circle_markers: aggregates.circleMarkers,

    csv_storage_path: body.storage_path,
    csv_size_bytes: csvSizeBytes,
    parser_version: 'v1',
  }

  const { error: upErr } = await supabase
    .from('meditation_sessions')
    .upsert(payload, { onConflict: 'id' })
  if (upErr) {
    return json({ error: 'db_upsert_failed', message: upErr.message }, 500)
  }

  /* sum(count) даёт боту достаточно для confirmation-сообщения без второго SELECT. */
  const circleMarkersCount = aggregates.circleMarkers
    ? aggregates.circleMarkers.reduce((s, m) => s + m.count, 0)
    : null

  return json({
    session_id: body.session_id,
    duration_min: Math.round(aggregates.durationSec / 60 * 10) / 10,
    duration_sec: aggregates.durationSec,
    signal_quality_pct: aggregates.signalQualityPct,
    signal_shift: aggregates.signalShiftAtSec === null ? null : {
      at_sec: aggregates.signalShiftAtSec,
      at_minute: Math.floor(aggregates.signalShiftAtSec / 60),
      severity: aggregates.signalShiftSeverity,
    },
    circle_markers_count: circleMarkersCount,
  })
})
