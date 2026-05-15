/* Edge Function: get-sessions-list
 *
 * Returns a flat list of sessions for the /meditation/ index page.
 * Each row carries enough fields for a card: date, duration, circles,
 * deepening, AB-index, longest calm, location, tags, kind/exclusion flags.
 *
 * Filters (all optional, all combined with AND):
 *   period      — 7 | 30 | 90 | 365 (default 90)
 *   tag         — single string from auto_tags (e.g. "глубокое углубление")
 *   location_id — uuid
 *   calm_only   — bool: only sessions where deepening_reliable=true, signal_quality>=80,
 *                 no shift_high (mirrors trends.isCalm minus auto_tags check we already do)
 *   include_excluded — bool: by default we hide excluded_from_stats=true; set true to see them
 *
 * Sorted by started_at DESC. Caps at 200 rows for safety.
 *
 * Auth: user JWT. RLS filters to current user.
 * Deploy: supabase functions deploy get-sessions-list */

import { createClient } from 'jsr:@supabase/supabase-js@2'

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
const DEFAULT_PERIOD = 90
const ROW_CAP = 200

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

  const url = new URL(req.url)
  const periodRaw = parseInt(url.searchParams.get('period') ?? '', 10)
  const period = VALID_PERIODS.has(periodRaw) ? periodRaw : DEFAULT_PERIOD
  const tag = url.searchParams.get('tag') ?? null
  const locationId = url.searchParams.get('location_id') ?? null
  const calmOnly = url.searchParams.get('calm_only') === 'true'
  const includeExcluded = url.searchParams.get('include_excluded') === 'true'

  const sinceIso = new Date(Date.now() - period * 24 * 60 * 60 * 1000).toISOString()

  let query = supabase
    .from('meditation_sessions')
    .select(`
      id, started_at, ended_at, duration_sec, circles, pace_min_per_circle,
      signal_quality_pct, signal_shift_severity, deepening_reliable,
      deepening_pct, ab_index_median, longest_calm_sec, calm_periods_count,
      duration_category, distracted, self_rating, auto_tags,
      session_kind, excluded_from_stats, excluded_reason,
      location:locations ( id, name )
    `)
    .gte('started_at', sinceIso)
    .order('started_at', { ascending: false })
    .limit(ROW_CAP)

  if (!includeExcluded) query = query.eq('excluded_from_stats', false)
  if (locationId) query = query.eq('location_id', locationId)
  if (tag) query = query.contains('auto_tags', [tag])
  if (calmOnly) {
    query = query
      .gte('signal_quality_pct', 80)
      .eq('deepening_reliable', true)
      .neq('signal_shift_severity', 'high')
  }

  const { data, error } = await query
  if (error) return json({ error: 'db_error', message: error.message }, 500)

  /* Also load the set of tags + locations used in this window for filter UI. */
  const { data: facetRaw } = await supabase
    .from('meditation_sessions')
    .select('auto_tags, location:locations(id, name)')
    .gte('started_at', sinceIso)
    .order('started_at', { ascending: false })
    .limit(500)

  const allTags = new Set<string>()
  const locationMap = new Map<string, string>()
  for (const row of (facetRaw ?? [])) {
    for (const t of (row.auto_tags as string[] | null) ?? []) allTags.add(t)
    /* Supabase types nested FK select as an array even when relation is one-to-one. */
    const loc = unwrapLocation(row.location)
    if (loc) locationMap.set(loc.id, loc.name)
  }
  const tagFacets = [...allTags].sort((a, b) => a.localeCompare(b, 'ru'))
  const locationFacets = [...locationMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))

  const now = new Date()
  const today = now.toISOString().slice(0, 10)

  const sessions = (data ?? []).map((row: Record<string, unknown>) => {
    const loc = unwrapLocation(row.location)
    const startedAt = row.started_at as string
    return {
      id: row.id,
      startedAt,
      isToday: startedAt.slice(0, 10) === today,
      date: friendlyDate(startedAt, now),
      time: formatTime(startedAt),
      durationMin: Math.round((row.duration_sec as number) / 60 * 10) / 10,
      circles: row.circles,
      paceMinPerCircle: row.pace_min_per_circle,
      signalQualityPct: row.signal_quality_pct,
      signalShiftSeverity: row.signal_shift_severity,
      deepeningReliable: row.deepening_reliable,
      deepeningPct: row.deepening_reliable ? row.deepening_pct : null,
      abIndexMedian: row.ab_index_median,
      longestCalmSec: row.longest_calm_sec,
      calmPeriodsCount: row.calm_periods_count,
      durationCategory: row.duration_category,
      distracted: row.distracted,
      selfRating: row.self_rating,
      tags: (row.auto_tags as string[] | null) ?? [],
      kind: row.session_kind,
      excludedFromStats: row.excluded_from_stats,
      excludedReason: row.excluded_reason,
      location: loc ? { id: loc.id, name: loc.name } : null,
    }
  })

  return json({
    period,
    filters: { tag, location_id: locationId, calm_only: calmOnly, include_excluded: includeExcluded },
    total: sessions.length,
    sessions,
    facets: { tags: tagFacets, locations: locationFacets },
  })
})

function friendlyDate(iso: string, now: Date): string {
  const d = new Date(iso)
  const isSameDay = (a: Date, b: Date) =>
    a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate()
  if (isSameDay(d, now)) return 'сегодня'
  const y = new Date(now); y.setUTCDate(now.getUTCDate() - 1)
  if (isSameDay(d, y)) return 'вчера'
  return `${d.getUTCDate()} ${monthRu(d.getUTCMonth())}`
}

function monthRu(m: number): string {
  return ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][m]
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/* The PostgREST FK select returns either an object or a 1-element array depending
 * on relationship metadata. Normalize to a single record (or null). */
function unwrapLocation(value: unknown): { id: string; name: string } | null {
  if (!value) return null
  if (Array.isArray(value)) {
    const first = value[0] as { id?: unknown; name?: unknown } | undefined
    if (!first || typeof first.id !== 'string' || typeof first.name !== 'string') return null
    return { id: first.id, name: first.name }
  }
  const obj = value as { id?: unknown; name?: unknown }
  if (typeof obj.id !== 'string' || typeof obj.name !== 'string') return null
  return { id: obj.id, name: obj.name }
}
