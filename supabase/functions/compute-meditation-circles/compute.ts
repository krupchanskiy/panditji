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
  /* Зоны устойчивости в интервале круга. NULL у всех четырёх = у сессии нет
   * zone_log. zone_samples = 0 + pct = null = монитор не писал зоны на этом
   * круге (например, пока шла автокалибровка порога в начале). */
  zone_green_pct: number | null
  zone_yellow_pct: number | null
  zone_red_pct: number | null
  zone_samples: number | null
}

export type DurationCategory = 'standard' | 'short' | 'long'

export type CircleMarker = { t_sec: number; count: number }

export type ZoneSample = { t_sec: number; zone: 0 | 1 | 2 }

/* Результат aggregateZones. null = у сессии вообще нет zone_log; иначе
 * всегда объект с samples ≥ 0. При samples === 0 проценты тоже null
 * (отличаем «нет замеров в этом круге» от «100% какой-то зоны»). */
export type ZoneAgg = {
  green_pct: number | null
  yellow_pct: number | null
  red_pct: number | null
  samples: number
} | null

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
  /* Опциональные метки кругов из CSV (Circle_Marker от внешнего инструмента).
   * null или пустой массив → старая логика равных отрезков. */
  circleMarkers?: CircleMarker[] | null
  /* Опциональный лог зон устойчивости из CSV (Zone от внешнего монитора).
   * null → перцикловые поля zone_* в CircleAgg все станут null,
   * zonesOverall в результате тоже null. */
  zoneLog?: ZoneSample[] | null
}

export type CirclesSource = 'markers' | 'manual' | 'equal'

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
  /* Откуда взяты границы кругов:
   *   markers — реальные тайминги, sum(count) совпал с circlesCount;
   *   manual  — метки есть, но число подтверждено пользователем вручную и
   *             расходится с sum(count) (хвост перераспределён или обрезан);
   *   equal   — меток не было, равные отрезки. */
  circlesSource: CirclesSource
  /* Зоны устойчивости по всей сессии (0..durationSec). null = zoneLog
   * отсутствует — UI «Светофор» в этом случае показывает fallback-сообщение. */
  zonesOverall: ZoneAgg
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

  /* Выбор способа границ. По умолчанию — старое поведение (равные отрезки).
   * Включаем "по якорям" только если метки валидны и в осмысленном диапазоне. */
  let circles: CircleAgg[]
  let circlesSource: CirclesSource
  const markers = input.circleMarkers
  const zoneLog = input.zoneLog ?? null
  if (markers && markers.length > 0 && validMarkers(markers, input.durationSec)) {
    circles = splitByMarkers(input.timeline30s, input.durationSec, input.circlesCount, markers, zoneLog)
    const sumCount = markers.reduce((s, m) => s + m.count, 0)
    circlesSource = sumCount === input.circlesCount ? 'markers' : 'manual'
  } else {
    if (markers && markers.length > 0) {
      console.warn('circle markers present but invalid — falling back to equal split')
    }
    circles = splitIntoCircles(input.timeline30s, input.durationSec, input.circlesCount, zoneLog)
    circlesSource = 'equal'
  }
  const paceMinPerCircle = (input.durationSec / input.circlesCount) / 60
  const zonesOverall = aggregateZones(zoneLog, 0, input.durationSec)

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
    circlesSource,
    zonesOverall,
  }
}

/* ── zones aggregation ────────────────────────────────────────────────── */

/* Считает доли зон в полуинтервале [tStart, tEnd). null если zoneLog отсутствует.
 * При наличии zoneLog, но нулевом числе попаданий — возвращает {pct: null × 3,
 * samples: 0}: семантически отличает «у сессии нет зон вовсе» от «в этом круге
 * монитор зоны не писал», важно для UI (приглушённая рамка vs fallback-текст). */
export function aggregateZones(
  zoneLog: ZoneSample[] | null, tStart: number, tEnd: number,
): ZoneAgg {
  if (!zoneLog) return null
  let g = 0, y = 0, r = 0, samples = 0
  for (const z of zoneLog) {
    if (z.t_sec >= tStart && z.t_sec < tEnd) {
      samples++
      if (z.zone === 0) g++
      else if (z.zone === 1) y++
      else r++
    }
  }
  if (samples === 0) {
    return { green_pct: null, yellow_pct: null, red_pct: null, samples: 0 }
  }
  return {
    green_pct:  round1(g / samples * 100),
    yellow_pct: round1(y / samples * 100),
    red_pct:    round1(r / samples * 100),
    samples,
  }
}

/* Берёт ZoneAgg и возвращает четвёрку полей в формате CircleAgg
 * (null/null/null/null если zoneLog у сессии отсутствовал). */
function zoneFieldsFor(agg: ZoneAgg): {
  zone_green_pct: number | null
  zone_yellow_pct: number | null
  zone_red_pct: number | null
  zone_samples: number | null
} {
  if (agg === null) {
    return { zone_green_pct: null, zone_yellow_pct: null, zone_red_pct: null, zone_samples: null }
  }
  return {
    zone_green_pct: agg.green_pct,
    zone_yellow_pct: agg.yellow_pct,
    zone_red_pct: agg.red_pct,
    zone_samples: agg.samples,
  }
}

/* ── circle split ─────────────────────────────────────────────────────── */

function splitIntoCircles(
  timeline: TimelineWindow[], durationSec: number, n: number,
  zoneLog: ZoneSample[] | null,
): CircleAgg[] {
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
      ...zoneFieldsFor(aggregateZones(zoneLog, tStart, tEnd)),
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

/* Защита от мусора в метках. Парсер уже отбросил невалидные значения и
 * отсортировал по t_sec; здесь — последний барьер в compute. */
function validMarkers(markers: CircleMarker[], durationSec: number): boolean {
  if (markers.length === 0) return false
  let prev = -Infinity
  let sumCount = 0
  for (const m of markers) {
    if (!Number.isFinite(m.t_sec) || m.t_sec < 0 || m.t_sec > durationSec) return false
    if (m.t_sec <= prev) return false   // монотонность строгая
    if (!Number.isFinite(m.count) || m.count < 1) return false
    prev = m.t_sec
    sumCount += m.count
  }
  return sumCount >= 1
}

/* Случай A: метки = реальные временные якоря.
 * Каждая метка m: «к моменту m.t_sec закрылось ещё m.count кругов с прошлой».
 * Алгоритм:
 *   prevT = 0, prevCircle = 0.
 *   Для каждой метки делим [prevT, m.t_sec] на m.count равных под-интервалов.
 *   Хвост [lastMarkerT, durationSec] вмещает (circlesCount - prevCircle) кругов:
 *     > 0 → делим хвост равными под-интервалами;
 *     == 0 → хвоста нет;
 *     < 0  (override: пользователь указал меньше суммы меток) → берём первые
 *           circlesCount границ, остаток обрезаем с конца. */
function splitByMarkers(
  timeline: TimelineWindow[], durationSec: number,
  circlesCount: number, markers: CircleMarker[],
  zoneLog: ZoneSample[] | null,
): CircleAgg[] {
  const boundaries: Array<{ tStart: number; tEnd: number }> = []
  let prevT = 0
  let prevCircle = 0

  for (const m of markers) {
    const span = m.t_sec - prevT
    if (span <= 0) continue
    const step = span / m.count
    for (let i = 0; i < m.count; i++) {
      const tStart = prevT + i * step
      const tEnd = prevT + (i + 1) * step
      boundaries.push({ tStart, tEnd })
    }
    prevT = m.t_sec
    prevCircle += m.count
  }

  /* Хвост до конца сессии. */
  const tailCount = circlesCount - prevCircle
  if (tailCount > 0 && prevT < durationSec) {
    const span = durationSec - prevT
    const step = span / tailCount
    for (let i = 0; i < tailCount; i++) {
      const tStart = prevT + i * step
      const tEnd = (i === tailCount - 1) ? durationSec : (prevT + (i + 1) * step)
      boundaries.push({ tStart, tEnd })
    }
  }

  /* Override: пользователь указал меньше суммы меток — обрезаем лишние с конца. */
  const finalBoundaries = boundaries.slice(0, circlesCount)

  return finalBoundaries.map((b, idx) => {
    const tStart = Math.round(b.tStart)
    const tEnd = (idx === finalBoundaries.length - 1)
      ? Math.max(tStart + 1, Math.min(durationSec, Math.round(b.tEnd)))
      : Math.round(b.tEnd)

    const wins = timeline.filter(w => w.t >= tStart && w.t < tEnd)
    const src = wins.length > 0 ? wins : nearestWindows(timeline, tStart, tEnd)

    const goodInCircle = src.filter(w => w.signal_ok)
    const aggSrc = goodInCircle.length > 0 ? goodInCircle : src
    const signalPct = src.length > 0 ? (goodInCircle.length / src.length) * 100 : 0

    return {
      circle_num: idx + 1,
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
      ...zoneFieldsFor(aggregateZones(zoneLog, tStart, tEnd)),
    }
  })
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
