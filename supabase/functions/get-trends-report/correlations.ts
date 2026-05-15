/* Spearman rank correlations + a box-plot for the four cards on the Stats screen.
 *
 * Brief 11.4:
 *   - Spearman (non-parametric, robust to outliers) for three scatter cards.
 *   - Box-plot of deepening_pct grouped by `distracted` (3 levels).
 *   - For the box-plot, the calm-only filter is NOT applied — otherwise the
 *     "сильно" group disappears, since calm sessions exclude tech-issue sessions.
 *   - Significance: |r| > 0.3 AND n >= 14. Below n=10 → result null + "недостаточно данных".
 *   - pValue stays null — we don't compute Student's t / normal approximation.
 *     Significance from |r| threshold is enough to flag a card on the UI. */

import { median, quantile } from '../parse-meditation-csv/stats.ts'
import { isCalm, isIncludedInAggregates, SessionForTrends } from './trends.ts'

export type CorrelationResult = {
  n: number
  r: number | null
  pValue: number | null
  significant: boolean
  interpretation: string
}

export type BoxPlotResult = {
  groups: Array<{
    label: 'никто' | 'немного' | 'сильно'
    n: number
    median: number | null
    q1: number | null
    q3: number | null
    min: number | null
    max: number | null
  }>
  interpretation: string
}

export type CorrelationsReport = {
  sleepVsDeepening: CorrelationResult
  recoveryVsStability: CorrelationResult
  distractedVsDeepening: BoxPlotResult
  selfRatingVsAb: CorrelationResult
}

export const CORRELATION_MIN_N = 10
export const CORRELATION_SIGNIFICANT_R = 0.3
export const CORRELATION_SIGNIFICANT_MIN_N = 14

/* ── public entry ──────────────────────────────────────────────────────── */

export function computeCorrelations(
  sessions: SessionForTrends[], calmOnly: boolean,
): CorrelationsReport {
  const baseFilter = sessions.filter(isIncludedInAggregates)
  const calmFilter = baseFilter.filter(s => !calmOnly || isCalm(s))

  return {
    sleepVsDeepening: spearmanCard(
      paired(calmFilter, s => s.whoop_sleep_hours, deepeningOf),
    ),
    recoveryVsStability: spearmanCard(
      paired(calmFilter, s => s.whoop_recovery_pct, s => s.ab_index_median),
    ),
    /* Distracted: full base set, NOT calm-filtered. */
    distractedVsDeepening: computeBoxPlot(baseFilter),
    selfRatingVsAb: spearmanCard(
      paired(calmFilter, s => s.self_rating, s => s.ab_index_median),
    ),
  }
}

/* deepening included only when reliable — same gate as in TrendSession.deepening. */
function deepeningOf(s: SessionForTrends): number | null {
  return s.deepening_reliable === true ? s.deepening_pct : null
}

/* ── correlation card ──────────────────────────────────────────────────── */

function spearmanCard({ xs, ys }: { xs: number[]; ys: number[] }): CorrelationResult {
  const n = xs.length
  if (n < CORRELATION_MIN_N) {
    return {
      n, r: null, pValue: null, significant: false,
      interpretation: `недостаточно данных (n=${n}, нужно ≥${CORRELATION_MIN_N})`,
    }
  }
  const r = spearman(xs, ys)
  const sig = r !== null && Math.abs(r) > CORRELATION_SIGNIFICANT_R && n >= CORRELATION_SIGNIFICANT_MIN_N
  return {
    n,
    r: r !== null ? round2(r) : null,
    pValue: null,
    significant: sig,
    interpretation: r !== null ? interpretCorrelation(r, n) : 'корреляции не обнаружено',
  }
}

/* Brief 11.4 wording. r positive ↔ "положительная", abs magnitude → "слабая/умеренная/сильная". */
export function interpretCorrelation(r: number, n: number): string {
  const abs = Math.abs(r)
  const tail = `(r=${round2(r)}, n=${n})`
  if (abs < 0.2) return `корреляции не обнаружено ${tail}`
  const sign = r >= 0 ? 'положительная' : 'отрицательная'
  if (abs < 0.4) return `слабая ${sign} связь ${tail}`
  if (abs < 0.7) return `умеренная ${sign} связь ${tail}`
  return `сильная ${sign} связь ${tail}`
}

/* ── Spearman = Pearson of ranks ───────────────────────────────────────── */

export function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null
  return pearson(rankWithTies(xs), rankWithTies(ys))
}

/* Average-rank for ties. Example: rankWithTies([3,1,3,2]) → [3.5, 1, 3.5, 2]. */
export function rankWithTies(values: number[]): number[] {
  const indexed = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v)
  const ranks = new Array(values.length).fill(0)
  let i = 0
  while (i < indexed.length) {
    let j = i
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++
    const avg = (i + j - 1) / 2 + 1     // 1-based midpoint
    for (let k = i; k < j; k++) ranks[indexed[k].i] = avg
    i = j
  }
  return ranks
}

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length
  let mx = 0, my = 0
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i] }
  mx /= n; my /= n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  if (dx === 0 || dy === 0) return 0   // constant series — no correlation
  return num / Math.sqrt(dx * dy)
}

/* ── pair extraction ───────────────────────────────────────────────────── */

function paired<T>(
  arr: T[],
  pickX: (t: T) => number | null,
  pickY: (t: T) => number | null,
): { xs: number[]; ys: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (const t of arr) {
    const x = pickX(t), y = pickY(t)
    if (x === null || y === null) continue
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    xs.push(x); ys.push(y)
  }
  return { xs, ys }
}

/* ── box-plot for distracted → deepening ───────────────────────────────── */

const DISTRACTED_LEVELS: BoxPlotResult['groups'][number]['label'][] =
  ['никто', 'немного', 'сильно']

function computeBoxPlot(sessions: SessionForTrends[]): BoxPlotResult {
  const groups = DISTRACTED_LEVELS.map(label => {
    const values: number[] = []
    for (const s of sessions) {
      if (s.distracted !== label) continue
      const d = deepeningOf(s)
      if (d !== null && Number.isFinite(d)) values.push(d)
    }
    return makeGroupStat(label, values)
  })

  return {
    groups,
    interpretation: interpretBoxPlot(groups),
  }
}

function makeGroupStat(
  label: BoxPlotResult['groups'][number]['label'],
  values: number[],
): BoxPlotResult['groups'][number] {
  if (values.length === 0) {
    return { label, n: 0, median: null, q1: null, q3: null, min: null, max: null }
  }
  return {
    label,
    n: values.length,
    median: round2(median(values)),
    q1: round2(quantile(values, 0.25)),
    q3: round2(quantile(values, 0.75)),
    min: round2(Math.min(...values)),
    max: round2(Math.max(...values)),
  }
}

function interpretBoxPlot(groups: BoxPlotResult['groups']): string {
  const nikto = groups.find(g => g.label === 'никто')
  const silno = groups.find(g => g.label === 'сильно')
  if (!nikto || !silno || nikto.n < 3 || silno.n < 3) {
    return 'недостаточно данных в одной из групп'
  }
  const diff = nikto.median! - silno.median!
  if (diff > 15) return `когда не отвлекают, углубление заметно глубже (медианы ${nikto.median} vs ${silno.median})`
  if (diff > 5) return `небольшая разница: меньше отвлечений — выше углубление (${nikto.median} vs ${silno.median})`
  if (diff < -5) return `обратный паттерн: с отвлечениями углубление выше — стоит присмотреться`
  return `связь не выражена (медианы ${nikto.median} vs ${silno.median})`
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
