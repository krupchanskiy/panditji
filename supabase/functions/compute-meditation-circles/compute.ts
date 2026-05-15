/* Pure: split a parsed session into circles + derive deepening, calm-periods, duration category.
 * Runs after the user confirms `circles` in the bot. Pure — no DB I/O. */

import { median, quantile } from '../parse-meditation-csv/stats.ts'

export type TimelineWindow = {
  t: number
  alpha: number
  theta: number
  beta: number
  gamma: number
  delta: number
  ab: number
  tb: number
  signal_ok: boolean
}

export type CircleAgg = {
  circle_num: number
  t_start_sec: number
  t_end_sec: number
  alpha_rel: number
  theta_rel: number
  beta_rel: number
  gamma_rel: number
  delta_rel: number
  ab_index: number
  tb_index: number
  signal_pct: number
}

export type DurationCategory = 'standard' | 'short' | 'long'

export type ComputeInput = {
  durationSec: number
  thetaFirstThird: number      // from parser
  thetaLastThird: number
  signalShiftAtSec: number | null
  timeline30s: TimelineWindow[]
  circlesCount: number          // confirmed by user in bot
  /* Other regular-session durations (sec) for the user, last 30 days.
   * Empty array (or <5 entries) → duration_category falls back to 'standard'. */
  recentRegularDurations: number[]
}

export type ComputeResult = {
  circles: CircleAgg[]
  paceMinPerCircle: number
  deepeningPct: number | null         // null = not computed (theta_first<1%)
  deepeningReliable: boolean
  longestCalmSec: number
  longestCalmAtSec: number
  calmPeriodsCount: number
  durationCategory: DurationCategory
  durationVsMedianPct: number | null  // null when no baseline (<5 sessions)
}

/* Caps and thresholds — exported for tests, named so a future reader understands intent. */
export const DEEPENING_RELIABILITY_FLOOR = 1.0      // theta_first_third must be ≥ 1%
export const DEEPENING_SANITY_CEILING_PCT = 200     // |Δ| > 200% is implausible, mark unreliable
export const DURATION_CATEGORY_TOLERANCE_PCT = 25   // ±25% from median = 'standard'
export const DURATION_CATEGORY_MIN_HISTORY = 5
export const CALM_AB_PERCENTILE = 0.75
export const CALM_MIN_RUN_WINDOWS = 2               // ≥2 windows = ≥60 sec
const WINDOW_SEC = 30

export function computeCircles(input: ComputeInput): ComputeResult {
  if (input.circlesCount < 1) {
    throw new Error('circlesCount must be ≥ 1')
  }

  const circles = splitIntoCircles(input.timeline30s, input.durationSec, input.circlesCount)
  const paceMinPerCircle = (input.durationSec / input.circlesCount) / 60

  const { deepeningPct, deepeningReliable } = computeDeepening(
    input.thetaFirstThird, input.thetaLastThird, input.signalShiftAtSec,
  )

  /* Calm periods: only on the timeline portion before any signal shift. */
  const calmTimeline = input.signalShiftAtSec === null
    ? input.timeline30s
    : input.timeline30s.filter(w => w.t < input.signalShiftAtSec!)

  const { longestSec, longestAtSec, periodsCount } = computeCalm(calmTimeline)

  const { category, vsMedianPct } = computeDurationCategory(
    input.durationSec, input.recentRegularDurations,
  )

  return {
    circles,
    paceMinPerCircle: round2(paceMinPerCircle),
    deepeningPct: deepeningPct === null ? null : round2(deepeningPct),
    deepeningReliable,
    longestCalmSec: longestSec,
    longestCalmAtSec: longestAtSec,
    calmPeriodsCount: periodsCount,
    durationCategory: category,
    durationVsMedianPct: vsMedianPct === null ? null : round1(vsMedianPct),
  }
}

/* ── circle split ─────────────────────────────────────────────────────── */

function splitIntoCircles(timeline: TimelineWindow[], durationSec: number, n: number): CircleAgg[] {
  const circleLen = durationSec / n
  const out: CircleAgg[] = []

  for (let i = 0; i < n; i++) {
    const tStart = Math.round(i * circleLen)
    const tEnd = i === n - 1 ? durationSec : Math.round((i + 1) * circleLen)
    const wins = timeline.filter(w => w.t >= tStart && w.t < tEnd)

    /* Fallback: if no windows in this circle (shouldn't happen with 30s windows and circles ≥3 min,
     * but guard against degenerate inputs), use neighbours. */
    const src = wins.length > 0 ? wins : nearestWindows(timeline, tStart, tEnd)

    const goodInCircle = src.filter(w => w.signal_ok)
    const aggSrc = goodInCircle.length > 0 ? goodInCircle : src
    const signalPct = src.length > 0 ? (goodInCircle.length / src.length) * 100 : 0

    out.push({
      circle_num: i + 1,
      t_start_sec: tStart,
      t_end_sec: tEnd,
      alpha_rel: round2(median(aggSrc.map(w => w.alpha))),
      theta_rel: round2(median(aggSrc.map(w => w.theta))),
      beta_rel:  round2(median(aggSrc.map(w => w.beta))),
      gamma_rel: round2(median(aggSrc.map(w => w.gamma))),
      delta_rel: round2(median(aggSrc.map(w => w.delta))),
      ab_index:  round2(median(aggSrc.map(w => w.ab))),
      tb_index:  round2(median(aggSrc.map(w => w.tb))),
      signal_pct: round2(signalPct),
    })
  }
  return out
}

function nearestWindows(timeline: TimelineWindow[], tStart: number, tEnd: number): TimelineWindow[] {
  if (timeline.length === 0) return []
  const mid = (tStart + tEnd) / 2
  let best = timeline[0]
  let bestDist = Math.abs(mid - best.t)
  for (const w of timeline) {
    const d = Math.abs(mid - w.t)
    if (d < bestDist) { best = w; bestDist = d }
  }
  return [best]
}

/* ── deepening ─────────────────────────────────────────────────────────── */

function computeDeepening(
  thetaFirst: number, thetaLast: number, signalShiftAtSec: number | null,
): { deepeningPct: number | null; deepeningReliable: boolean } {
  if (thetaFirst < DEEPENING_RELIABILITY_FLOOR) {
    // Division by near-zero would explode the ratio. Don't compute.
    return { deepeningPct: null, deepeningReliable: false }
  }
  const pct = (thetaLast - thetaFirst) / thetaFirst * 100

  // We still return the raw value when reliable=false (caller logs it) — UI hides it.
  const reliable = Math.abs(pct) <= DEEPENING_SANITY_CEILING_PCT && signalShiftAtSec === null
  return { deepeningPct: pct, deepeningReliable: reliable }
}

/* ── calm periods (P75 ab_index) ───────────────────────────────────────── */

function computeCalm(timeline: TimelineWindow[]): {
  longestSec: number; longestAtSec: number; periodsCount: number
} {
  if (timeline.length === 0) {
    return { longestSec: 0, longestAtSec: 0, periodsCount: 0 }
  }

  // P75 threshold over the session's own ab values — relative, not absolute.
  // Idea: calm = top quartile of stability for THIS session, not "Beta < average".
  const goodAbs = timeline.filter(w => w.signal_ok).map(w => w.ab)
  if (goodAbs.length === 0) {
    return { longestSec: 0, longestAtSec: 0, periodsCount: 0 }
  }
  const abP75 = quantile(goodAbs, CALM_AB_PERCENTILE)

  const isCalm = timeline.map(w => w.signal_ok && w.ab > abP75)

  const { length, start } = findLongestRun(isCalm)
  const periodsCount = countRunsAtLeast(isCalm, CALM_MIN_RUN_WINDOWS)

  return {
    longestSec: length * WINDOW_SEC,
    longestAtSec: start * WINDOW_SEC,
    periodsCount,
  }
}

function findLongestRun(flags: boolean[]): { length: number; start: number } {
  let bestLen = 0, bestStart = 0
  let curLen = 0, curStart = 0
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      if (curLen === 0) curStart = i
      curLen++
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart }
    } else {
      curLen = 0
    }
  }
  return { length: bestLen, start: bestStart }
}

function countRunsAtLeast(flags: boolean[], minLen: number): number {
  let runs = 0, curLen = 0
  for (const f of flags) {
    if (f) {
      curLen++
    } else {
      if (curLen >= minLen) runs++
      curLen = 0
    }
  }
  if (curLen >= minLen) runs++
  return runs
}

/* ── duration category ─────────────────────────────────────────────────── */

function computeDurationCategory(
  durationSec: number, recent: number[],
): { category: DurationCategory; vsMedianPct: number | null } {
  if (recent.length < DURATION_CATEGORY_MIN_HISTORY) {
    return { category: 'standard', vsMedianPct: null }
  }
  const med = median(recent)
  if (med <= 0) return { category: 'standard', vsMedianPct: null }
  const dev = (durationSec - med) / med * 100
  if (Math.abs(dev) <= DURATION_CATEGORY_TOLERANCE_PCT) return { category: 'standard', vsMedianPct: dev }
  return { category: dev < 0 ? 'short' : 'long', vsMedianPct: dev }
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function round1(v: number): number { return Math.round(v * 10) / 10 }
function round2(v: number): number { return Math.round(v * 100) / 100 }

/* Exposed for tests. */
export const __test__ = { findLongestRun, countRunsAtLeast }
