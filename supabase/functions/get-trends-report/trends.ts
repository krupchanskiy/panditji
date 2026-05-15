/* Pure trends builder: list of sessions → TrendsReport.
 *
 * Filters per the brief:
 *   - sessions[] uses isIncludedInTrends (excluded_from_stats=false, circles!=null).
 *   - SMA + avgPerCircle aggregates use isIncludedInAggregates: above + duration_category ∈ {standard, null}.
 *   - calm_only flag is layered on top of both — see isCalm.
 *
 * avgCalmNormalized / avgAllNormalized stay null here — those come from
 * meditation_baseline (computed in the next block). Correlations come even later. */

import { mean } from '../parse-meditation-csv/stats.ts'

export type SessionForTrends = {
  id: string
  started_at: string
  duration_sec: number
  circles: number | null
  pace_min_per_circle: number | null
  signal_quality_pct: number
  signal_shift_severity: 'medium' | 'high' | null
  deepening_reliable: boolean | null
  deepening_pct: number | null
  ab_index_median: number
  longest_calm_sec: number | null
  duration_category: 'standard' | 'short' | 'long' | null
  whoop_sleep_hours: number | null
  whoop_recovery_pct: number | null
  distracted: string | null
  self_rating: number | null
  auto_tags: string[]
  excluded_from_stats: boolean
  location_name: string | null
}

export type TrendSession = {
  idx: number
  id: string
  date: string                 // "DD.MM"
  day: number
  month: number
  isToday: boolean
  deepening: number | null
  ab: number
  sleep: number | null
  recovery: number | null
  distracted: string | null
  rating: number | null
  location: string | null
  durationMin: number
  circles: number
  longestCalmSec: number | null
  durationCategory: 'standard' | 'short' | 'long' | null
}

/* Per-position normalized averages — one row's worth from meditation_baseline. */
export type NormalizedBaseline = {
  alpha: number[] | null
  theta: number[] | null
  beta: number[] | null
  ab: number[] | null
}

export type TrendsReport = {
  period: number                 // 7 | 30 | 90 | 365
  calmOnly: boolean
  total: number
  totalMinutes: number
  avgDuration: number | null
  avgPerCircle: number | null
  goodSignalPercent: number | null

  sessions: TrendSession[]

  sma7Deepening: Array<number | null>   // same length as sessions, null where window too small or deepening missing
  sma7Ab: Array<number | null>

  /* Per-position normalized averages from meditation_baseline. Null when no
   * baseline row exists or it has fewer than the minimum sessions. */
  avgCalmNormalized: NormalizedBaseline | null
  avgAllNormalized: NormalizedBaseline | null

  /* Correlations are stubbed; populated in a later block. */
  correlations: null
}

export type BuildTrendsInput = {
  period: number                 // days
  calmOnly: boolean
  now: Date                      // for isToday
  sessions: SessionForTrends[]   // already date-filtered by caller (last N days)
  avgCalmNormalized?: NormalizedBaseline | null
  avgAllNormalized?: NormalizedBaseline | null
}

/* ── filters ───────────────────────────────────────────────────────────── */

export function isIncludedInTrends(s: SessionForTrends): boolean {
  return s.excluded_from_stats === false && s.circles !== null
}

export function isIncludedInAggregates(s: SessionForTrends): boolean {
  return isIncludedInTrends(s)
    && (s.duration_category === 'standard' || s.duration_category === null)
}

/* Calm-only filter — only technical quality, NEVER self_rating/distracted (circular reasoning). */
export function isCalm(s: SessionForTrends): boolean {
  return s.signal_quality_pct >= 80
    && !s.auto_tags.includes('технические проблемы')
    && s.signal_shift_severity !== 'high'
    && s.deepening_reliable === true
}

/* ── main ──────────────────────────────────────────────────────────────── */

export function buildTrendsReport(input: BuildTrendsInput): TrendsReport {
  // sessions[] feed: trends-eligible, optionally calm-only.
  const inSessions = input.sessions
    .filter(isIncludedInTrends)
    .filter(s => !input.calmOnly || isCalm(s))
    .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))

  // Aggregates feed: above + standard/null duration.
  const inAggregates = inSessions.filter(isIncludedInAggregates)

  const sessions: TrendSession[] = inSessions.map((s, idx) => toTrendSession(s, idx, input.now))

  // SMA-7: window of up to last 7 entries, requires ≥3 values to publish.
  const sma7Deepening = computeSma(
    sessions.map(s => s.deepening),
    sessions.map(s => isAggSession(inAggregates, s)),
  )
  const sma7Ab = computeSma(
    sessions.map(s => s.ab),
    sessions.map(s => isAggSession(inAggregates, s)),
  )

  const totalMinutes = round1(sessions.reduce((acc, s) => acc + s.durationMin, 0))
  const avgDuration = sessions.length > 0
    ? round1(mean(sessions.map(s => s.durationMin)))
    : null

  // avgPerCircle: only over sessions that hold their own pace (aggregate set).
  const paces = inAggregates
    .map(s => s.pace_min_per_circle)
    .filter((v): v is number => v !== null)
  const avgPerCircle = paces.length > 0 ? round1(mean(paces)) : null

  const goodSignals = inSessions.map(s => s.signal_quality_pct)
  const goodSignalPercent = goodSignals.length > 0 ? round1(mean(goodSignals)) : null

  return {
    period: input.period,
    calmOnly: input.calmOnly,
    total: sessions.length,
    totalMinutes,
    avgDuration,
    avgPerCircle,
    goodSignalPercent,
    sessions,
    sma7Deepening,
    sma7Ab,
    avgCalmNormalized: input.avgCalmNormalized ?? null,
    avgAllNormalized: input.avgAllNormalized ?? null,
    correlations: null,
  }
}

/* ── per-session mapping ───────────────────────────────────────────────── */

function toTrendSession(s: SessionForTrends, idx: number, now: Date): TrendSession {
  const d = new Date(s.started_at)
  const day = d.getUTCDate()
  const month = d.getUTCMonth() + 1
  const isToday = sameUtcDate(d, now)

  return {
    idx,
    id: s.id,
    date: `${pad2(day)}.${pad2(month)}`,
    day,
    month,
    isToday,
    deepening: s.deepening_reliable === true ? s.deepening_pct : null,
    ab: s.ab_index_median,
    sleep: s.whoop_sleep_hours,
    recovery: s.whoop_recovery_pct,
    distracted: s.distracted,
    rating: s.self_rating,
    location: s.location_name,
    durationMin: round1(s.duration_sec / 60),
    circles: s.circles!,            // filtered to non-null by isIncludedInTrends
    longestCalmSec: s.longest_calm_sec,
    durationCategory: s.duration_category,
  }
}

function isAggSession(inAggregates: SessionForTrends[], t: TrendSession): boolean {
  return inAggregates.some(s => s.id === t.id)
}

/* ── SMA-7 ─────────────────────────────────────────────────────────────── */

const SMA_WINDOW = 7
const SMA_MIN_VALUES = 3

/* For each session i: mean of last ≤7 values from the aggregate set,
 * within (i - SMA_WINDOW + 1 .. i). Null when fewer than SMA_MIN_VALUES
 * usable points, or when this session isn't in the aggregate set itself. */
function computeSma(values: Array<number | null>, isAgg: boolean[]): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null)
  for (let i = 0; i < values.length; i++) {
    if (!isAgg[i]) continue
    const lo = Math.max(0, i - SMA_WINDOW + 1)
    const window: number[] = []
    for (let j = lo; j <= i; j++) {
      if (!isAgg[j]) continue
      const v = values[j]
      if (v !== null) window.push(v)
    }
    out[i] = window.length >= SMA_MIN_VALUES ? round2(mean(window)) : null
  }
  return out
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function sameUtcDate(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate()
}

function round1(v: number): number { return Math.round(v * 10) / 10 }
function round2(v: number): number { return Math.round(v * 100) / 100 }
