/* Pure: compute baseline aggregates over a session set for one (period × calm_only) slot.
 *
 * The brief's normalization idea: each session's circles are stretched onto a 16-bin
 * position axis (0..1 from session start), so sessions with different circle counts
 * (12-rounded, 16-rounded) compare like-for-like. The baseline at bin i is the mean
 * across all qualifying sessions of THEIR bin i.
 *
 * Filters that select sessions for baseline are the same as get-trends-report:
 *   - isIncludedInAggregates (excluded=false, circles!=null, standard/null duration)
 *   - + isCalm when calm_only=true (technical quality only; never self_rating). */

import { mean } from '../parse-meditation-csv/stats.ts'

export const BIN_COUNT = 16

export type SessionForBaseline = {
  id: string
  duration_sec: number
  circles: number | null
  signal_quality_pct: number
  signal_shift_severity: 'medium' | 'high' | null
  deepening_reliable: boolean | null
  deepening_pct: number | null
  ab_index_median: number
  beta_median_rel: number
  longest_calm_sec: number | null
  calm_periods_count: number | null
  duration_category: 'standard' | 'short' | 'long' | null
  auto_tags: string[]
  excluded_from_stats: boolean
  /* Per-circle values from meditation_circles, ordered by circle_num ascending. */
  per_circle: {
    alpha: number[]
    theta: number[]
    beta: number[]
    ab: number[]
  }
}

export type Baseline = {
  session_count: number
  avg_deepening: number | null
  avg_stability: number | null
  avg_beta: number | null
  avg_longest_calm_sec: number | null
  avg_calm_periods_count: number | null
  avg_alpha_normalized: number[] | null    // [16] or null
  avg_theta_normalized: number[] | null
  avg_beta_normalized: number[] | null
  avg_ab_normalized: number[] | null
}

export const BASELINE_MIN_SESSIONS = 5

/* Same filters as trends — duplicated here so baseline-recompute stays self-contained
 * (no cross-folder import surprises during Supabase function bundling). */
export function isIncludedInAggregates(s: SessionForBaseline): boolean {
  return s.excluded_from_stats === false
    && s.circles !== null
    && (s.duration_category === 'standard' || s.duration_category === null)
}

export function isCalm(s: SessionForBaseline): boolean {
  return s.signal_quality_pct >= 80
    && !s.auto_tags.includes('технические проблемы')
    && s.signal_shift_severity !== 'high'
    && s.deepening_reliable === true
}

export function computeBaseline(allSessions: SessionForBaseline[], calmOnly: boolean): Baseline {
  const filtered = allSessions
    .filter(isIncludedInAggregates)
    .filter(s => !calmOnly || isCalm(s))

  const empty: Baseline = {
    session_count: filtered.length,
    avg_deepening: null,
    avg_stability: null,
    avg_beta: null,
    avg_longest_calm_sec: null,
    avg_calm_periods_count: null,
    avg_alpha_normalized: null,
    avg_theta_normalized: null,
    avg_beta_normalized: null,
    avg_ab_normalized: null,
  }

  if (filtered.length < BASELINE_MIN_SESSIONS) return empty

  /* Session-level scalars. deepening uses only reliable values (already gated by isCalm
   * when calm_only=true, but for !calmOnly we still want to skip unreliable). */
  const deepenings = filtered
    .filter(s => s.deepening_reliable === true && s.deepening_pct !== null)
    .map(s => s.deepening_pct!)
  const longestCalms = filtered
    .map(s => s.longest_calm_sec)
    .filter((v): v is number => v !== null)
  const periodCounts = filtered
    .map(s => s.calm_periods_count)
    .filter((v): v is number => v !== null)

  /* Per-position bins. Skip sessions whose per_circle arrays are empty. */
  const haveCircles = filtered.filter(s => s.per_circle.alpha.length > 0)
  const alphaBinsBySession = haveCircles.map(s => normalizeToBins(s.per_circle.alpha))
  const thetaBinsBySession = haveCircles.map(s => normalizeToBins(s.per_circle.theta))
  const betaBinsBySession = haveCircles.map(s => normalizeToBins(s.per_circle.beta))
  const abBinsBySession = haveCircles.map(s => normalizeToBins(s.per_circle.ab))

  return {
    session_count: filtered.length,
    avg_deepening: deepenings.length > 0 ? round2(mean(deepenings)) : null,
    avg_stability: round2(mean(filtered.map(s => s.ab_index_median))),
    avg_beta: round2(mean(filtered.map(s => s.beta_median_rel))),
    avg_longest_calm_sec: longestCalms.length > 0 ? Math.round(mean(longestCalms)) : null,
    avg_calm_periods_count: periodCounts.length > 0 ? round1(mean(periodCounts)) : null,
    avg_alpha_normalized: averageBins(alphaBinsBySession),
    avg_theta_normalized: averageBins(thetaBinsBySession),
    avg_beta_normalized:  averageBins(betaBinsBySession),
    avg_ab_normalized:    averageBins(abBinsBySession),
  }
}

/* Brief 7.2 algorithm: take values of length N, redistribute into BIN_COUNT bins
 * by position [i/BIN_COUNT, (i+1)/BIN_COUNT]. Each bin gets the mean of values
 * whose source indices fall into that fractional range. */
export function normalizeToBins(values: number[]): number[] {
  const N = values.length
  if (N === 0) return new Array(BIN_COUNT).fill(NaN)
  const bins: number[] = new Array(BIN_COUNT)
  for (let i = 0; i < BIN_COUNT; i++) {
    const startIdx = Math.floor((i / BIN_COUNT) * N)
    const endIdx = Math.ceil(((i + 1) / BIN_COUNT) * N)
    // Guarantee at least one value: when N < BIN_COUNT, start may equal end.
    const lo = startIdx
    const hi = Math.max(endIdx, lo + 1)
    const slice = values.slice(lo, hi)
    bins[i] = round2(mean(slice))
  }
  return bins
}

/* Average bin i across all sessions. Returns null array if no sessions. */
function averageBins(perSession: number[][]): number[] | null {
  if (perSession.length === 0) return null
  const out: number[] = new Array(BIN_COUNT)
  for (let i = 0; i < BIN_COUNT; i++) {
    out[i] = round2(mean(perSession.map(s => s[i])))
  }
  return out
}

function round1(v: number): number { return Math.round(v * 10) / 10 }
function round2(v: number): number { return Math.round(v * 100) / 100 }
