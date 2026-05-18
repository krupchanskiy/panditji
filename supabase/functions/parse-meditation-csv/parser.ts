/* Pure parser for Mind Monitor CSV.
 *
 * Splits raw CSV text into session-level aggregates + 30-sec timeline.
 * Does NOT split into circles, does NOT compute deepening/longest_calm —
 * those happen later in compute-meditation-circles after user confirms circles.
 *
 * Throws ParseError on unrecoverable issues (structure, too short, headband off).
 * Returns aggregates otherwise — auto_tags like "noisy recording" are assigned upstream. */

import { mean, median, quantile } from './stats.ts'

const REQUIRED_HEADERS = [
  'TimeStamp',
  'Delta_TP9', 'Delta_AF7', 'Delta_AF8', 'Delta_TP10',
  'Theta_TP9', 'Theta_AF7', 'Theta_AF8', 'Theta_TP10',
  'Alpha_TP9', 'Alpha_AF7', 'Alpha_AF8', 'Alpha_TP10',
  'Beta_TP9', 'Beta_AF7', 'Beta_AF8', 'Beta_TP10',
  'Gamma_TP9', 'Gamma_AF7', 'Gamma_AF8', 'Gamma_TP10',
  'HSI_TP9', 'HSI_AF7', 'HSI_AF8', 'HSI_TP10',
  'HeadBandOn', 'Heart_Rate',
] as const

const ELECTRODES = ['TP9', 'AF7', 'AF8', 'TP10'] as const
type Electrode = typeof ELECTRODES[number]

export type ElectrodeStatus = 'ok' | 'warn' | 'bad'
export type ArtifactsLevel = 'низкий' | 'умеренный' | 'высокий'
export type SignalShiftSeverity = 'medium' | 'high'

export type TimelineWindow = {
  t: number                  // start of window, seconds from session start
  alpha: number              // median relative power, %
  theta: number
  beta: number
  gamma: number
  delta: number
  ab: number                 // alpha/beta linear-power ratio
  tb: number                 // theta/beta linear-power ratio
  signal_ok: boolean         // majority of EEG rows in window had HSI≤2
}

/* Метка круга из колонки Circle_Marker внешнего инструмента.
 * t_sec — секунды от ПЕРВОЙ EEG-строки сессии (firstTsMs), а НЕ от
 * абстрактного «момента старта»: у внешнего инструмента старт сессии и
 * первая EEG-строка разнесены во времени. Источник истины — позиция
 * строки с непустым Circle_Marker в самом CSV. */
export type CircleMarker = {
  t_sec: number
  count: number              // сколько кругов закрылось этой меткой/серией
}

export type SessionAggregates = {
  startedAt: string          // ISO
  endedAt: string
  durationSec: number

  signalQualityPct: number
  artifactsLevel: ArtifactsLevel
  electrodesStatus: Record<Electrode, ElectrodeStatus>
  headbandOnPct: number

  signalShiftAtSec: number | null
  signalShiftSeverity: SignalShiftSeverity | null

  alphaMedianRel: number
  thetaMedianRel: number
  betaMedianRel: number
  gammaMedianRel: number
  deltaMedianRel: number
  abIndexMedian: number
  tbIndexMedian: number

  alphaFirstThird: number
  alphaLastThird: number
  thetaFirstThird: number
  thetaLastThird: number
  deltaFirstThird: number
  deltaLastThird: number

  hrFirstThird: number | null
  hrLastThird: number | null
  hrMedian: number | null

  timeline30s: TimelineWindow[]

  /* null = колонки Circle_Marker не было ИЛИ все её значения оказались невалидны.
   * В обоих случаях downstream работает как для телефонного Mind Monitor. */
  circleMarkers: CircleMarker[] | null
}

export type ParseErrorCode = 'structure' | 'too_short' | 'headband_off'

export class ParseError extends Error {
  constructor(public code: ParseErrorCode, message: string) {
    super(message)
    this.name = 'ParseError'
  }
}

/* Single EEG-aggregate row (~1 Hz). Mind Monitor also writes raw EEG sample rows
 * at higher rate without band aggregates — we skip those for analysis. */
type EegRow = {
  t: number                  // seconds from session start
  alphaLin: number
  thetaLin: number
  betaLin: number
  gammaLin: number
  deltaLin: number
  alphaRel: number           // % of total band power
  thetaRel: number
  betaRel: number
  gammaRel: number
  deltaRel: number
  abIndex: number
  tbIndex: number
  hsiOk: Record<Electrode, boolean>
  signalOk: boolean          // all 4 HSI ≤ 2
  headbandOn: boolean
  hr: number | null
}

/* Parse Mind Monitor CSV text into session aggregates.
 * CSV format: header row + N data rows. Some rows have EEG band aggregates,
 * others have only raw EEG / optics — we filter on Theta_TP9 being non-empty. */
export function parseMindMonitorCSV(text: string): SessionAggregates {
  const lines = splitCsvLines(text)
  if (lines.length < 2) {
    throw new ParseError('structure', 'CSV пуст или нет данных после заголовка')
  }

  const colIdx = parseHeader(lines[0])
  /* Опциональная колонка Circle_Marker от внешнего инструмента. -1 = не было. */
  const circleMarkerIdx = lines[0].split(',').indexOf('Circle_Marker')

  /* First pass: collect timestamps + EEG rows.
   * Mind Monitor writes HeadBandOn only on EEG-aggregate rows (raw-sample rows leave it empty),
   * so headbandOnPct is computed over rows where HeadBandOn is non-empty — not the full CSV. */
  let firstTsMs: number | null = null
  let lastTsMs: number | null = null
  let headbandStatusRows = 0
  let headbandOnCount = 0

  const eegRows: EegRow[] = []
  /* Собираем метки кругов параллельно. Каждая метка получает t_sec
   * относительно firstTsMs — той же базы, что timeline и thirds. */
  const rawMarkers: Array<{ tsMs: number; count: number }> = []

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(',')
    if (fields.length < REQUIRED_HEADERS.length) continue

    const tsStr = fields[colIdx.TimeStamp]
    if (!tsStr) continue
    const tsMs = parseTimestamp(tsStr)
    if (Number.isNaN(tsMs)) continue

    if (firstTsMs === null) firstTsMs = tsMs
    lastTsMs = tsMs

    const hbo = fields[colIdx.HeadBandOn]
    if (hbo === '1' || hbo === '0') {
      headbandStatusRows++
      if (hbo === '1') headbandOnCount++
    }

    /* Circle_Marker — опциональная колонка от внешнего инструмента.
     * t_sec считается ТОЛЬКО из позиции строки в CSV: (tsMs - firstTsMs) / 1000.
     * Не опираемся на JSON-файл и не предполагаем, что нуль отсчёта
     * совпадает с моментом старта сессии — у внешнего инструмента это
     * разные моменты. Источник истины — сам CSV. */
    if (circleMarkerIdx >= 0 && circleMarkerIdx < fields.length) {
      const raw = fields[circleMarkerIdx]
      if (raw && raw.length > 0) {
        const n = parseInt(raw, 10)
        /* Принимаем только целые ≥1. Дробные / 0 / отрицательные / NaN —
         * молча пропускаем, не падая (см. ТЗ §171, п.5). */
        if (Number.isFinite(n) && n >= 1 && String(n) === raw.trim()) {
          rawMarkers.push({ tsMs, count: n })
        }
      }
    }

    /* EEG-aggregate row: Theta_TP9 non-empty. Other rows skipped from analysis. */
    const thetaTP9raw = fields[colIdx.Theta_TP9]
    if (!thetaTP9raw) continue

    const bands = readBands(fields, colIdx)
    if (!bands) continue

    const totalLin = bands.alphaLin + bands.thetaLin + bands.betaLin + bands.gammaLin + bands.deltaLin
    if (totalLin <= 0) continue

    const hsiOk: Record<Electrode, boolean> = {
      TP9: parseFloat(fields[colIdx.HSI_TP9]) <= 2,
      AF7: parseFloat(fields[colIdx.HSI_AF7]) <= 2,
      AF8: parseFloat(fields[colIdx.HSI_AF8]) <= 2,
      TP10: parseFloat(fields[colIdx.HSI_TP10]) <= 2,
    }
    const signalOk = hsiOk.TP9 && hsiOk.AF7 && hsiOk.AF8 && hsiOk.TP10

    const hrRaw = fields[colIdx.Heart_Rate]
    const hr = hrRaw ? parseFloat(hrRaw) : NaN
    const hrSafe = Number.isFinite(hr) && hr >= 30 ? hr : null

    eegRows.push({
      t: 0, // filled below once firstTsMs is known for all rows
      alphaLin: bands.alphaLin,
      thetaLin: bands.thetaLin,
      betaLin: bands.betaLin,
      gammaLin: bands.gammaLin,
      deltaLin: bands.deltaLin,
      alphaRel: bands.alphaLin / totalLin * 100,
      thetaRel: bands.thetaLin / totalLin * 100,
      betaRel: bands.betaLin / totalLin * 100,
      gammaRel: bands.gammaLin / totalLin * 100,
      deltaRel: bands.deltaLin / totalLin * 100,
      abIndex: bands.alphaLin / bands.betaLin,
      tbIndex: bands.thetaLin / bands.betaLin,
      hsiOk,
      signalOk,
      headbandOn: hbo === '1',
      hr: hrSafe,
      // capture raw ts to compute t after first pass
      // (we'll reassign via a parallel array — see below)
    } as EegRow)
    // store raw ts in a parallel structure
    ;(eegRows[eegRows.length - 1] as EegRow & { _tsMs: number })._tsMs = tsMs
  }

  if (firstTsMs === null || lastTsMs === null) {
    throw new ParseError('structure', 'Не найдено ни одной валидной строки с TimeStamp')
  }

  const durationSec = Math.round((lastTsMs - firstTsMs) / 1000)
  if (durationSec < 5 * 60) {
    throw new ParseError('too_short', `Сессия слишком короткая: ${durationSec} сек`)
  }

  const headbandOnPct = headbandStatusRows > 0
    ? (headbandOnCount / headbandStatusRows) * 100
    : 0
  if (headbandOnPct < 50) {
    throw new ParseError(
      'headband_off',
      `Повязка не была надета большую часть сессии: HeadBandOn=${headbandOnPct.toFixed(1)}%`,
    )
  }

  if (eegRows.length === 0) {
    throw new ParseError('structure', 'Нет ни одной EEG-агрегатной строки в CSV')
  }

  /* Fill t (seconds from start) now that firstTsMs is final. */
  for (const r of eegRows) {
    const tsMs = (r as EegRow & { _tsMs: number })._tsMs
    r.t = (tsMs - firstTsMs) / 1000
  }

  /* Signal quality: % of EEG rows with all 4 HSI≤2. */
  const signalGoodCount = eegRows.reduce((acc, r) => acc + (r.signalOk ? 1 : 0), 0)
  const signalQualityPct = (signalGoodCount / eegRows.length) * 100

  const electrodesStatus: Record<Electrode, ElectrodeStatus> = {
    TP9: electrodeStatus(eegRows, 'TP9'),
    AF7: electrodeStatus(eegRows, 'AF7'),
    AF8: electrodeStatus(eegRows, 'AF8'),
    TP10: electrodeStatus(eegRows, 'TP10'),
  }

  const artifactsLevel: ArtifactsLevel =
    signalQualityPct >= 90 ? 'низкий' : signalQualityPct >= 70 ? 'умеренный' : 'высокий'

  /* All session-level medians use only signal_ok rows. */
  const goodRows = eegRows.filter(r => r.signalOk)
  // Fall back to all rows if every single row had a bad HSI — better than NaN.
  const aggSource = goodRows.length > 0 ? goodRows : eegRows

  const alphaMedianRel = median(aggSource.map(r => r.alphaRel))
  const thetaMedianRel = median(aggSource.map(r => r.thetaRel))
  const betaMedianRel = median(aggSource.map(r => r.betaRel))
  const gammaMedianRel = median(aggSource.map(r => r.gammaRel))
  const deltaMedianRel = median(aggSource.map(r => r.deltaRel))
  const abIndexMedian = median(aggSource.map(r => r.abIndex))
  const tbIndexMedian = median(aggSource.map(r => r.tbIndex))

  /* Thirds (relative to session duration, not row count — accounts for non-uniform sampling). */
  const thirds = sliceThirds(aggSource, durationSec)
  const alphaFirstThird = median(thirds.first.map(r => r.alphaRel))
  const alphaLastThird = median(thirds.last.map(r => r.alphaRel))
  const thetaFirstThird = median(thirds.first.map(r => r.thetaRel))
  const thetaLastThird = median(thirds.last.map(r => r.thetaRel))
  const deltaFirstThird = median(thirds.first.map(r => r.deltaRel))
  const deltaLastThird = median(thirds.last.map(r => r.deltaRel))

  /* HR — from all EEG rows (HSI doesn't gate HR; we already filter hr<30 at row level). */
  const allHr = eegRows.map(r => r.hr).filter((v): v is number => v !== null)
  const hrThirds = sliceThirdsHr(eegRows, durationSec)
  const hrMedian_ = allHr.length > 0 ? median(allHr) : null
  const hrFirstThird = hrThirds.first.length > 0 ? median(hrThirds.first) : null
  const hrLastThird = hrThirds.last.length > 0 ? median(hrThirds.last) : null

  /* 30-sec timeline. Each window: medians over EEG rows in window (signal_ok only when available). */
  const timeline30s = computeTimeline30s(eegRows, durationSec)

  /* Signal-shift detector. */
  const shift = detectSignalShift(timeline30s)

  /* Финализируем метки кругов: t_sec от firstTsMs, сортировка по времени.
   * compute дополнительно проверит монотонность как защитный слой. */
  let circleMarkers: CircleMarker[] | null = null
  if (rawMarkers.length > 0) {
    circleMarkers = rawMarkers
      .map(m => ({ t_sec: round2((m.tsMs - firstTsMs!) / 1000), count: m.count }))
      .sort((a, b) => a.t_sec - b.t_sec)
  }

  return {
    startedAt: new Date(firstTsMs).toISOString(),
    endedAt: new Date(lastTsMs).toISOString(),
    durationSec,
    signalQualityPct: round2(signalQualityPct),
    artifactsLevel,
    electrodesStatus,
    headbandOnPct: round2(headbandOnPct),
    signalShiftAtSec: shift?.atSec ?? null,
    signalShiftSeverity: shift?.severity ?? null,
    alphaMedianRel: round2(alphaMedianRel),
    thetaMedianRel: round2(thetaMedianRel),
    betaMedianRel: round2(betaMedianRel),
    gammaMedianRel: round2(gammaMedianRel),
    deltaMedianRel: round2(deltaMedianRel),
    abIndexMedian: round2(abIndexMedian),
    tbIndexMedian: round2(tbIndexMedian),
    alphaFirstThird: round2(alphaFirstThird),
    alphaLastThird: round2(alphaLastThird),
    thetaFirstThird: round2(thetaFirstThird),
    thetaLastThird: round2(thetaLastThird),
    deltaFirstThird: round2(deltaFirstThird),
    deltaLastThird: round2(deltaLastThird),
    hrFirstThird: hrFirstThird !== null ? round1(hrFirstThird) : null,
    hrLastThird: hrLastThird !== null ? round1(hrLastThird) : null,
    hrMedian: hrMedian_ !== null ? round1(hrMedian_) : null,
    timeline30s,
    circleMarkers,
  }
}

/* ─── internals ─────────────────────────────────────────────────────────── */

function splitCsvLines(text: string): string[] {
  // Mind Monitor CSV: simple line splitting (no embedded newlines in fields).
  return text.split(/\r?\n/).filter(l => l.length > 0)
}

type ColIdx = Record<typeof REQUIRED_HEADERS[number], number>

function parseHeader(headerLine: string): ColIdx {
  const fields = headerLine.split(',')
  const map: Partial<ColIdx> = {}
  for (const name of REQUIRED_HEADERS) {
    const idx = fields.indexOf(name)
    if (idx === -1) {
      throw new ParseError('structure', `В CSV не найдена обязательная колонка ${name}`)
    }
    map[name] = idx
  }
  return map as ColIdx
}

function parseTimestamp(s: string): number {
  // "2026-05-15 06:37:10.858" → ms. Treat as local; we only use deltas, so TZ doesn't matter.
  // Replace space with 'T' to make ISO-ish.
  const iso = s.replace(' ', 'T')
  const t = Date.parse(iso)
  return Number.isNaN(t) ? NaN : t
}

function readBands(fields: string[], idx: ColIdx): {
  alphaLin: number; thetaLin: number; betaLin: number; gammaLin: number; deltaLin: number
} | null {
  // Mind Monitor writes log10 PSD (Bels). Average across 4 electrodes, then 10^x → linear.
  const bandLin = (cols: number[]): number => {
    const vals: number[] = []
    for (const c of cols) {
      const v = parseFloat(fields[c])
      if (Number.isFinite(v)) vals.push(v)
    }
    if (vals.length === 0) return NaN
    const avgBels = vals.reduce((a, b) => a + b, 0) / vals.length
    return Math.pow(10, avgBels)
  }

  const alphaLin = bandLin([idx.Alpha_TP9, idx.Alpha_AF7, idx.Alpha_AF8, idx.Alpha_TP10])
  const thetaLin = bandLin([idx.Theta_TP9, idx.Theta_AF7, idx.Theta_AF8, idx.Theta_TP10])
  const betaLin = bandLin([idx.Beta_TP9, idx.Beta_AF7, idx.Beta_AF8, idx.Beta_TP10])
  const gammaLin = bandLin([idx.Gamma_TP9, idx.Gamma_AF7, idx.Gamma_AF8, idx.Gamma_TP10])
  const deltaLin = bandLin([idx.Delta_TP9, idx.Delta_AF7, idx.Delta_AF8, idx.Delta_TP10])

  if (!Number.isFinite(alphaLin) || !Number.isFinite(thetaLin) ||
      !Number.isFinite(betaLin) || !Number.isFinite(gammaLin) ||
      !Number.isFinite(deltaLin)) {
    return null
  }
  return { alphaLin, thetaLin, betaLin, gammaLin, deltaLin }
}

function electrodeStatus(rows: EegRow[], e: Electrode): ElectrodeStatus {
  const okCount = rows.reduce((acc, r) => acc + (r.hsiOk[e] ? 1 : 0), 0)
  const pct = (okCount / rows.length) * 100
  if (pct > 90) return 'ok'
  if (pct >= 70) return 'warn'
  return 'bad'
}

function sliceThirds(rows: EegRow[], durationSec: number): {
  first: EegRow[]; last: EegRow[]
} {
  const third = durationSec / 3
  return {
    first: rows.filter(r => r.t < third),
    last: rows.filter(r => r.t >= 2 * third),
  }
}

function sliceThirdsHr(rows: EegRow[], durationSec: number): {
  first: number[]; last: number[]
} {
  const third = durationSec / 3
  const first: number[] = []
  const last: number[] = []
  for (const r of rows) {
    if (r.hr === null) continue
    if (r.t < third) first.push(r.hr)
    else if (r.t >= 2 * third) last.push(r.hr)
  }
  return { first, last }
}

const WINDOW_SEC = 30

function computeTimeline30s(rows: EegRow[], durationSec: number): TimelineWindow[] {
  const windows: TimelineWindow[] = []
  const numWindows = Math.floor(durationSec / WINDOW_SEC)

  for (let w = 0; w < numWindows; w++) {
    const wStart = w * WINDOW_SEC
    const wEnd = wStart + WINDOW_SEC
    const inWin = rows.filter(r => r.t >= wStart && r.t < wEnd)
    if (inWin.length === 0) continue

    const goodInWin = inWin.filter(r => r.signalOk)
    const src = goodInWin.length > 0 ? goodInWin : inWin
    const majorityOk = goodInWin.length >= inWin.length / 2

    windows.push({
      t: wStart,
      alpha: round2(median(src.map(r => r.alphaRel))),
      theta: round2(median(src.map(r => r.thetaRel))),
      beta: round2(median(src.map(r => r.betaRel))),
      gamma: round2(median(src.map(r => r.gammaRel))),
      delta: round2(median(src.map(r => r.deltaRel))),
      ab: round2(median(src.map(r => r.abIndex))),
      tb: round2(median(src.map(r => r.tbIndex))),
      signal_ok: majorityOk,
    })
  }
  return windows
}

/* Signal-shift detector. Looks for a step change in band powers that:
 *   1) deviates from the prior 5-min baseline (Theta ×2.5 OR Alpha ×0.4)
 *   2) persists for the next 5 min (≤30% drift from the step's value)
 * HSI doesn't catch headband slippage, so we detect it via band-power discontinuity. */
function detectSignalShift(timeline: TimelineWindow[]): {
  atSec: number; severity: SignalShiftSeverity
} | null {
  const HISTORY = 10  // 10 windows × 30s = 5 min
  const FUTURE = 10

  for (let i = HISTORY; i < timeline.length - 1; i++) {
    const win = timeline[i]
    if (!win.signal_ok) continue

    const baseline = timeline.slice(i - HISTORY, i).filter(w => w.signal_ok)
    if (baseline.length < HISTORY / 2) continue

    const thetaBase = median(baseline.map(w => w.theta))
    const alphaBase = median(baseline.map(w => w.alpha))
    if (thetaBase <= 0 || alphaBase <= 0) continue

    const thetaJump = win.theta > thetaBase * 2.5
    const alphaDrop = win.alpha < alphaBase * 0.4

    if (!thetaJump && !alphaDrop) continue

    // Persistence check.
    const future = timeline.slice(i, Math.min(timeline.length, i + FUTURE)).filter(w => w.signal_ok)
    if (future.length < 5) continue

    const thetaNext = median(future.map(w => w.theta))
    if (win.theta <= 0) continue
    const drift = Math.abs(thetaNext - win.theta) / win.theta
    if (drift > 0.3) continue

    return {
      atSec: win.t,
      severity: thetaJump && alphaDrop ? 'high' : 'medium',
    }
  }
  return null
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

// Suppress unused (kept for future use in stats helpers re-exports).
void mean
void quantile
