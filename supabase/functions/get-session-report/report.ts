/* Pure mapping: DB rows → SessionReport for the PWA.
 *
 * Reflects sync with design: compare has three per-circle metrics
 * (deepening / stability / beta) — third one is Beta as background of mental
 * activity, not longestCalm. longestCalm sits in metadata as a single number.
 *
 * Baseline comparisons fill in when baselines are provided (per the Q3 lazy-pull
 * decision: caller loads them right before mapping). If baselines are absent
 * OR every period has fewer than the minimum sessions, hiddenReason becomes
 * 'no_baseline' and periods stay null. */

export type Phase = {
  label: string
  range: [number, number]
  note: string
}

export type PerCircleCompare = {
  todayValue: number              // session-level value (header chip)
  todayPerCircle: number[]        // N-length array, N = circles confirmed
  unit: '%' | 'index'
  periods: {
    w: PerCirclePeriodComparison | null
    m: PerCirclePeriodComparison | null
    q: PerCirclePeriodComparison | null
    all: PerCirclePeriodComparison | null
  }
  hiddenReason: HiddenReason
}

export type PerCirclePeriodComparison = {
  baselineValue: number           // session-level baseline (header)
  baselinePerCircle: number[]     // resampled to N points matching today
  deltaPct: number
  sessionCount: number
}

export type HiddenReason =
  | 'preview' | 'manual_exclude' | 'nonstandard_duration' | 'no_baseline' | null

export type SessionReport = {
  id: string
  date: string                     // "15 мая 2026, четверг" (ru-RU)
  time: { start: string; end: string }   // "06:37" / "07:37" — local time of recording
  durationMin: number
  circles: number | null
  paceMinPerCircle: number | null
  location: { id: string; name: string } | null

  kind: 'regular' | 'preview'
  excludedFromStats: boolean
  excludedReason: 'preview' | 'manual' | null

  context: {
    distracted: string | null
    selfRating: number | null
    whoopSleep: string | null         // "6:30" format
    whoopRecovery: number | null
    userNote: string | null
  }

  signal: {
    overall: number                   // % good
    artifacts: 'низкий' | 'умеренный' | 'высокий'
    electrodes: { TP9: string; AF7: string; AF8: string; TP10: string }
    headbandOnPct: number
    shift: { atSec: number; atMinute: number; severity: 'medium' | 'high' } | null
    deepeningReliable: boolean | null
  }

  perCircle: Array<{
    i: number; alpha: number; theta: number; beta: number
    /* Зоны устойчивости в этом круге.
     * null = у сессии вообще нет zone_log (телефонный экспорт);
     * samples = 0 при не-null объекте = в этом круге монитор зоны не писал. */
    zone: {
      green: number | null
      yellow: number | null
      red: number | null
      samples: number
    } | null
  }> | null

  /* Зоны устойчивости по всей сессии. null = у сессии нет zone_log. */
  zonesOverall: { green: number; yellow: number; red: number } | null

  compare: {
    deepening: PerCircleCompare
    stability: PerCircleCompare
    beta: PerCircleCompare
  }

  /* Metadata for chips / sparse stats — not per-circle. */
  longestCalmSec: number | null
  longestCalmAtSec: number | null
  calmPeriodsCount: number | null

  phases: Phase[] | null
  caption: { main: string | null; calm: string | null }
  tags: string[]

  durationCategory: 'standard' | 'short' | 'long' | null
  durationVsMedianPct: number | null
}

/* DB row shapes — narrow types so we don't drag the full Database type in. */

export type SessionRow = {
  id: string
  user_id: string
  started_at: string
  ended_at: string
  duration_sec: number
  location_id: string | null
  session_kind: 'regular' | 'preview'
  excluded_from_stats: boolean
  excluded_reason: 'preview' | 'manual' | null
  circles: number | null
  pace_min_per_circle: number | null
  signal_quality_pct: number
  artifacts_level: 'низкий' | 'умеренный' | 'высокий'
  electrodes_status: { TP9: string; AF7: string; AF8: string; TP10: string }
  headband_on_pct: number
  signal_shift_at_sec: number | null
  signal_shift_severity: 'medium' | 'high' | null
  deepening_reliable: boolean | null
  distracted: string | null
  self_rating: number | null
  user_note: string | null
  whoop_sleep_hours: number | null
  whoop_recovery_pct: number | null
  ab_index_median: number
  beta_median_rel: number
  deepening_pct: number | null
  longest_calm_sec: number | null
  longest_calm_at_sec: number | null
  calm_periods_count: number | null
  duration_category: 'standard' | 'short' | 'long' | null
  duration_vs_median_pct: number | null
  auto_tags: string[]
  interpretations: { main?: string; calm?: string | null; phases?: Phase[] } | null
  zone_green_pct: number | null
  zone_yellow_pct: number | null
  zone_red_pct: number | null
}

export type CircleRow = {
  circle_num: number
  alpha_rel: number
  theta_rel: number
  beta_rel: number
  ab_index: number
  zone_green_pct: number | null
  zone_yellow_pct: number | null
  zone_red_pct: number | null
  zone_samples: number | null
}

export type LocationRow = {
  id: string
  name: string
}

/* One row from meditation_baseline, narrowed. Caller supplies one row per period
 * for whichever calm_only flag the user selected (or null when row absent). */
export type BaselineRow = {
  session_count: number
  avg_deepening: number | null
  avg_stability: number | null
  avg_beta: number | null
  avg_theta_normalized: number[] | null
  avg_ab_normalized: number[] | null
  avg_beta_normalized: number[] | null
}

export type BaselinesByPeriod = {
  w: BaselineRow | null
  m: BaselineRow | null
  q: BaselineRow | null
  all: BaselineRow | null
}

const MIN_BASELINE_SESSIONS = 5

export function buildSessionReport(
  s: SessionRow,
  circles: CircleRow[],
  location: LocationRow | null,
  baselines: BaselinesByPeriod | null,
  resampleFn: (bins: number[], targetN: number) => number[],
): SessionReport {
  const circlesConfirmed = s.circles !== null && circles.length > 0
  const N = circlesConfirmed ? s.circles! : 0

  /* zone === null на круге = у сессии вообще нет zone_log (поле zone_samples
   * на круге тогда тоже NULL). Иначе кладём числовой samples и тройку pct
   * (внутри могут быть null если samples===0 — UI рисует приглушённую рамку). */
  const sessionHasZones = s.zone_green_pct !== null
    || s.zone_yellow_pct !== null
    || s.zone_red_pct !== null
  const perCircle = circlesConfirmed
    ? circles
        .slice()
        .sort((a, b) => a.circle_num - b.circle_num)
        .map(c => ({
          i: c.circle_num,
          alpha: c.alpha_rel,
          theta: c.theta_rel,
          beta: c.beta_rel,
          zone: c.zone_samples === null
            ? null
            : {
                green: c.zone_green_pct,
                yellow: c.zone_yellow_pct,
                red: c.zone_red_pct,
                samples: c.zone_samples,
              },
        }))
    : null

  const zonesOverall = sessionHasZones && s.zone_green_pct !== null
      && s.zone_yellow_pct !== null && s.zone_red_pct !== null
    ? { green: s.zone_green_pct, yellow: s.zone_yellow_pct, red: s.zone_red_pct }
    : null

  const baseHidden = pickHiddenReason(s)

  const deepening = makeCompare({
    todayValue: s.deepening_pct ?? 0,
    todayPerCircle: perCircle ? perCircle.map(c => c.theta) : [],
    unit: '%',
    baselines, baseHidden, N, resampleFn,
    valueOf: b => b.avg_deepening,
    binsOf: b => b.avg_theta_normalized,
  })
  const stability = makeCompare({
    todayValue: s.ab_index_median,
    todayPerCircle: circlesConfirmed ? circles.map(c => c.ab_index) : [],
    unit: 'index',
    baselines, baseHidden, N, resampleFn,
    valueOf: b => b.avg_stability,
    binsOf: b => b.avg_ab_normalized,
  })
  const beta = makeCompare({
    todayValue: s.beta_median_rel,
    todayPerCircle: perCircle ? perCircle.map(c => c.beta) : [],
    unit: '%',
    baselines, baseHidden, N, resampleFn,
    valueOf: b => b.avg_beta,
    binsOf: b => b.avg_beta_normalized,
  })

  return {
    id: s.id,
    date: formatDateRu(s.started_at),
    time: { start: formatTimeRu(s.started_at), end: formatTimeRu(s.ended_at) },
    durationMin: Math.round(s.duration_sec / 60 * 10) / 10,
    circles: s.circles,
    paceMinPerCircle: s.pace_min_per_circle,
    location: location ? { id: location.id, name: location.name } : null,

    kind: s.session_kind,
    excludedFromStats: s.excluded_from_stats,
    excludedReason: s.excluded_reason,

    context: {
      distracted: s.distracted,
      selfRating: s.self_rating,
      whoopSleep: s.whoop_sleep_hours !== null ? hoursToHm(s.whoop_sleep_hours) : null,
      whoopRecovery: s.whoop_recovery_pct,
      userNote: s.user_note,
    },

    signal: {
      overall: s.signal_quality_pct,
      artifacts: s.artifacts_level,
      electrodes: s.electrodes_status,
      headbandOnPct: s.headband_on_pct,
      shift: s.signal_shift_at_sec !== null && s.signal_shift_severity !== null
        ? {
            atSec: s.signal_shift_at_sec,
            atMinute: Math.floor(s.signal_shift_at_sec / 60),
            severity: s.signal_shift_severity,
          }
        : null,
      deepeningReliable: s.deepening_reliable,
    },

    perCircle,
    zonesOverall,
    compare: { deepening, stability, beta },

    longestCalmSec: s.longest_calm_sec,
    longestCalmAtSec: s.longest_calm_at_sec,
    calmPeriodsCount: s.calm_periods_count,

    phases: s.interpretations?.phases ?? null,
    caption: {
      main: s.interpretations?.main ?? null,
      calm: s.interpretations?.calm ?? null,
    },
    tags: s.auto_tags,

    durationCategory: s.duration_category,
    durationVsMedianPct: s.duration_vs_median_pct,
  }
}

/* ── helpers ───────────────────────────────────────────────────────────── */

/* "Hard" reasons that suppress comparisons regardless of baseline availability. */
function pickHiddenReason(s: SessionRow): HiddenReason {
  if (s.excluded_from_stats) {
    return s.excluded_reason === 'preview' ? 'preview' : 'manual_exclude'
  }
  if (s.duration_category === 'short' || s.duration_category === 'long') {
    return 'nonstandard_duration'
  }
  return null
}

function makeCompare(p: {
  todayValue: number
  todayPerCircle: number[]
  unit: '%' | 'index'
  baselines: BaselinesByPeriod | null
  baseHidden: HiddenReason
  N: number
  resampleFn: (bins: number[], n: number) => number[]
  valueOf: (b: BaselineRow) => number | null
  binsOf: (b: BaselineRow) => number[] | null
}): PerCircleCompare {
  /* Hard-hide overrides everything else. */
  if (p.baseHidden !== null) {
    return {
      todayValue: round2(p.todayValue),
      todayPerCircle: p.todayPerCircle.map(round2),
      unit: p.unit,
      periods: { w: null, m: null, q: null, all: null },
      hiddenReason: p.baseHidden,
    }
  }

  const periods = {
    w: makePeriod(p.baselines?.w ?? null, p),
    m: makePeriod(p.baselines?.m ?? null, p),
    q: makePeriod(p.baselines?.q ?? null, p),
    all: makePeriod(p.baselines?.all ?? null, p),
  }
  const anyAvailable = periods.w || periods.m || periods.q || periods.all

  return {
    todayValue: round2(p.todayValue),
    todayPerCircle: p.todayPerCircle.map(round2),
    unit: p.unit,
    periods,
    hiddenReason: anyAvailable ? null : 'no_baseline',
  }
}

function makePeriod(
  row: BaselineRow | null,
  p: {
    todayValue: number
    N: number
    resampleFn: (bins: number[], n: number) => number[]
    valueOf: (b: BaselineRow) => number | null
    binsOf: (b: BaselineRow) => number[] | null
  },
): PerCirclePeriodComparison | null {
  if (!row) return null
  if (row.session_count < MIN_BASELINE_SESSIONS) return null

  const value = p.valueOf(row)
  const bins = p.binsOf(row)
  if (value === null || bins === null) return null

  // Avoid divide-by-zero on deltaPct.
  const deltaPct = value !== 0 ? ((p.todayValue - value) / value) * 100 : 0
  const baselinePerCircle = p.N > 0 ? p.resampleFn(bins, p.N) : []

  return {
    baselineValue: round2(value),
    baselinePerCircle,
    deltaPct: round1(deltaPct),
    sessionCount: row.session_count,
  }
}

/* "2026-05-15T06:37:10.858Z" → "15 мая 2026, четверг" (ru-RU). */
export function formatDateRu(iso: string): string {
  const d = new Date(iso)
  // Day + month in nominative-as-numeral form ("15 мая"), then year, then weekday separately.
  const dayMonthYear = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric',
  }).format(d).replace(' г.', '')
  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(d)
  return `${dayMonthYear}, ${weekday}`
}

/* "2026-05-15T06:37:10.858Z" → "06:37" (UTC of the ISO).
 * Mind Monitor writes wall-clock as if it were UTC; we mirror that — no TZ tricks here. */
export function formatTimeRu(iso: string): string {
  const d = new Date(iso)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/* 6.5 → "6:30", 7.0 → "7:00", 7.25 → "7:15". Carries when rounding hits 60. */
export function hoursToHm(h: number): string {
  let hours = Math.floor(h)
  let minutes = Math.round((h - hours) * 60)
  if (minutes === 60) { minutes = 0; hours += 1 }
  return `${hours}:${String(minutes).padStart(2, '0')}`
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}
function round2(v: number): number {
  return Math.round(v * 100) / 100
}
