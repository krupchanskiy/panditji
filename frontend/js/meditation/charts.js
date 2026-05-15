/* SVG chart renderers — pure functions that return SVG markup strings.
 *
 * All charts draw at intrinsic (width, height) and use viewBox so they scale
 * inside a flex container. No external chart library — everything is hand-rolled
 * SVG so we control exact look and stay framework-free.
 *
 * Colours from the design tokens (oklch). */

export const CHART_COLORS = {
  alpha: 'oklch(0.62 0.090 235)',     // sage-blue
  alphaSoft: 'oklch(0.85 0.060 235 / 0.55)',
  theta: 'oklch(0.55 0.110 295)',     // lavender
  thetaSoft: 'oklch(0.80 0.080 295 / 0.55)',
  beta: 'oklch(0.66 0.090 28)',       // terra
  betaSoft: 'oklch(0.85 0.060 28 / 0.55)',
  gamma: 'oklch(0.75 0.05 60)',
  delta: 'oklch(0.55 0.03 230)',
  grid: 'oklch(0.85 0.012 235 / 0.65)',
  axis: 'oklch(0.62 0.015 240)',
  axisFaint: 'oklch(0.75 0.012 240)',
  calmFill: 'oklch(0.78 0.07 235 / 0.55)',
  calmEmpty: 'oklch(0.93 0.012 235 / 0.85)',
}

/* ── main chart: bars / stream / lines ─────────────────────────────────── */

const MAIN_CHART_PAD = { top: 8, right: 8, bottom: 22, left: 22 }
const MAIN_CHART_DEFAULT = { width: 348, height: 200 }

export function renderMainChart(perCircle, variant = 'bars', size = MAIN_CHART_DEFAULT) {
  if (!perCircle || perCircle.length === 0) return emptyMessage('Нет данных по кругам', size)
  switch (variant) {
    case 'stream': return renderMainChartStream(perCircle, size)
    case 'lines':  return renderMainChartLines(perCircle, size)
    case 'bars':
    default:       return renderMainChartBars(perCircle, size)
  }
}

function renderMainChartBars(perCircle, size) {
  const { width, height } = size
  const pad = MAIN_CHART_PAD
  const w = width - pad.left - pad.right
  const h = height - pad.top - pad.bottom

  const N = perCircle.length
  const maxBand = Math.max(60,
    ...perCircle.map(c => Math.max(c.alpha, c.theta)))
  const yMax = Math.ceil(maxBand / 10) * 10

  const groupWidth = w / N
  const barWidth = Math.max(2, (groupWidth - 4) / 2.4)

  const yScale = v => pad.top + h - (v / yMax) * h
  const xCircle = i => pad.left + i * groupWidth

  let bars = ''
  let betaPath = ''
  perCircle.forEach((c, i) => {
    const cx = xCircle(i) + groupWidth / 2
    const xAlpha = cx - barWidth - 1
    const xTheta = cx + 1
    bars += `<rect x="${xAlpha.toFixed(1)}" y="${yScale(c.alpha).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(h - (h - (c.alpha / yMax) * h)).toFixed(1)}" fill="${CHART_COLORS.alpha}" rx="1.5"/>`
    bars += `<rect x="${xTheta.toFixed(1)}" y="${yScale(c.theta).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${(h - (h - (c.theta / yMax) * h)).toFixed(1)}" fill="${CHART_COLORS.theta}" rx="1.5"/>`
    /* Beta line follows the centre of each group. */
    betaPath += (i === 0 ? 'M' : 'L') + `${cx.toFixed(1)} ${yScale(c.beta).toFixed(1)} `
  })

  return wrapSvg({ ...size, content: `
    ${gridLines(pad, w, h, yMax)}
    ${bars}
    <path d="${betaPath}" fill="none" stroke="${CHART_COLORS.beta}" stroke-width="1.2"/>
    ${xAxisTicks(perCircle, pad, w, h, height)}
  ` })
}

function renderMainChartStream(perCircle, size) {
  const { width, height } = size
  const pad = MAIN_CHART_PAD
  const w = width - pad.left - pad.right
  const h = height - pad.top - pad.bottom
  const N = perCircle.length

  /* Stacked area: beta bottom, alpha middle, theta top. */
  const x = i => pad.left + (i / Math.max(1, N - 1)) * w

  const stackMax = Math.max(...perCircle.map(c => c.alpha + c.theta + c.beta))
  const ceiling = Math.ceil(stackMax / 10) * 10
  const y = v => pad.top + h - (v / ceiling) * h

  const baseBeta = perCircle.map(c => c.beta)
  const baseAB = perCircle.map(c => c.alpha + c.beta)
  const baseATB = perCircle.map(c => c.alpha + c.beta + c.theta)

  const areaPath = (top, bottom) => {
    const upper = top.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
    const lower = bottom.slice().reverse().map((v, ri) => {
      const i = bottom.length - 1 - ri
      return `L ${x(i).toFixed(1)} ${y(v).toFixed(1)}`
    }).join(' ')
    return upper + ' ' + lower + ' Z'
  }

  const zeros = perCircle.map(_ => 0)
  const betaArea = areaPath(baseBeta, zeros)
  const alphaArea = areaPath(baseAB, baseBeta)
  const thetaArea = areaPath(baseATB, baseAB)

  return wrapSvg({ ...size, content: `
    ${gridLines(pad, w, h, ceiling)}
    <path d="${betaArea}" fill="${CHART_COLORS.betaSoft}" stroke="${CHART_COLORS.beta}" stroke-width="0.7"/>
    <path d="${alphaArea}" fill="${CHART_COLORS.alphaSoft}" stroke="${CHART_COLORS.alpha}" stroke-width="0.7"/>
    <path d="${thetaArea}" fill="${CHART_COLORS.thetaSoft}" stroke="${CHART_COLORS.theta}" stroke-width="0.7"/>
    ${xAxisTicks(perCircle, pad, w, h, height)}
  ` })
}

function renderMainChartLines(perCircle, size) {
  const { width, height } = size
  const pad = MAIN_CHART_PAD
  const w = width - pad.left - pad.right
  const h = height - pad.top - pad.bottom
  const N = perCircle.length

  const maxBand = Math.max(60, ...perCircle.flatMap(c => [c.alpha, c.theta, c.beta]))
  const yMax = Math.ceil(maxBand / 10) * 10

  const x = i => pad.left + (i / Math.max(1, N - 1)) * w
  const y = v => pad.top + h - (v / yMax) * h

  const buildLine = key => perCircle.map((c, i) =>
    `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(c[key]).toFixed(1)}`).join(' ')
  const buildDots = (key, color) => perCircle.map((c, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(c[key]).toFixed(1)}" r="2.2" fill="${color}"/>`).join('')

  return wrapSvg({ ...size, content: `
    ${gridLines(pad, w, h, yMax)}
    <path d="${buildLine('beta')}" fill="none" stroke="${CHART_COLORS.beta}" stroke-width="1.3" stroke-dasharray="3 3"/>
    <path d="${buildLine('alpha')}" fill="none" stroke="${CHART_COLORS.alpha}" stroke-width="1.5"/>
    <path d="${buildLine('theta')}" fill="none" stroke="${CHART_COLORS.theta}" stroke-width="1.5"/>
    ${buildDots('alpha', CHART_COLORS.alpha)}
    ${buildDots('theta', CHART_COLORS.theta)}
    ${xAxisTicks(perCircle, pad, w, h, height)}
  ` })
}

function gridLines(pad, w, h, yMax) {
  const ticks = 4
  let out = ''
  for (let i = 0; i <= ticks; i++) {
    const y = pad.top + (h / ticks) * i
    out += `<line x1="${pad.left}" y1="${y}" x2="${pad.left + w}" y2="${y}" stroke="${CHART_COLORS.grid}" stroke-width="0.5"/>`
    const v = yMax - (yMax / ticks) * i
    out += `<text x="${pad.left - 4}" y="${y + 3}" text-anchor="end" font-size="8.5" font-family="ui-monospace,monospace" fill="${CHART_COLORS.axis}">${Math.round(v)}</text>`
  }
  return out
}

function xAxisTicks(perCircle, pad, w, h, totalH) {
  const N = perCircle.length
  const xStep = w / N
  let out = ''
  for (let i = 0; i < N; i++) {
    const cx = pad.left + i * xStep + xStep / 2
    /* Label every circle for ≤16; for 24+ — every second. */
    const showLabel = N <= 16 || i % 2 === 0
    if (showLabel) {
      out += `<text x="${cx.toFixed(1)}" y="${(pad.top + h + 14).toFixed(1)}" text-anchor="middle" font-size="8.5" font-family="ui-monospace,monospace" fill="${CHART_COLORS.axis}">${i + 1}</text>`
    }
  }
  return out
}

/* ── chart legend ──────────────────────────────────────────────────────── */

export function ChartLegend({ items, compact = false }) {
  const fs = compact ? 'font-size: 10px;' : 'font-size: 11px;'
  return `<div class="chart-legend" style="display: flex; gap: 12px; align-items: center; ${fs}">
    ${items.map(it => `
      <span style="display: inline-flex; align-items: center; gap: 4px; opacity: ${it.faded ? 0.5 : 1};">
        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: ${it.color};"></span>
        <span style="color: var(--text-2);">${escapeHtml(it.label)}</span>
      </span>
    `).join('')}
  </div>`
}

/* ── calm strip — 16 cells, bracket over longest run ───────────────────── */

export function renderCalmStrip(perCircle, abValuesForP75, options = {}) {
  if (!perCircle || perCircle.length === 0) return emptyMessage('Нет данных', { width: 348, height: 46 })
  const N = perCircle.length
  const width = options.width ?? 348
  const height = options.height ?? 46
  const padX = 4
  const cellGap = 3
  const cellW = (width - padX * 2 - cellGap * (N - 1)) / N
  const cellH = 22
  const topPad = (height - cellH) / 2

  /* Threshold: P75 of ab over all available windows (calling page already pre-computed
   * the array). We highlight a cell when its (averaged) ab is above that. */
  const p75 = quantile(abValuesForP75, 0.75)
  const calmFlags = perCircle.map((c) => (c.ab ?? 0) > p75)

  let cells = ''
  for (let i = 0; i < N; i++) {
    const x = padX + i * (cellW + cellGap)
    const fill = calmFlags[i] ? CHART_COLORS.calmFill : CHART_COLORS.calmEmpty
    cells += `<rect x="${x.toFixed(1)}" y="${topPad}" width="${cellW.toFixed(1)}" height="${cellH}" fill="${fill}" rx="3"/>`
  }

  /* Find longest run for the bracket. */
  let bracket = ''
  const longest = findLongestRun(calmFlags)
  if (longest.length >= 2) {
    const xL = padX + longest.start * (cellW + cellGap)
    const xR = padX + (longest.start + longest.length - 1) * (cellW + cellGap) + cellW
    const yB = topPad - 5
    bracket = `
      <path d="M ${xL.toFixed(1)} ${(yB + 4).toFixed(1)} L ${xL.toFixed(1)} ${yB.toFixed(1)} L ${xR.toFixed(1)} ${yB.toFixed(1)} L ${xR.toFixed(1)} ${(yB + 4).toFixed(1)}" fill="none" stroke="${CHART_COLORS.alpha}" stroke-width="1"/>
    `
  }

  return wrapSvg({ width, height, content: cells + bracket })
}

/* ── compare per-circle (today vs baseline) ────────────────────────────── */

export function renderComparePerCircle({ todayPerCircle, baselinePerCircle, color, height = 64, width = 280 }) {
  if (!todayPerCircle || todayPerCircle.length === 0) return ''
  const pad = { top: 4, right: 4, bottom: 12, left: 4 }
  const w = width - pad.left - pad.right
  const h = height - pad.top - pad.bottom
  const N = todayPerCircle.length

  /* Shared vertical scale: max across both today and baseline (if present). */
  const allValues = todayPerCircle.concat(baselinePerCircle ?? [])
  const yMax = Math.max(...allValues) * 1.1
  const yMin = Math.min(...allValues) * 0.9

  const x = i => pad.left + (i / Math.max(1, N - 1)) * w
  const y = v => pad.top + h - ((v - yMin) / (yMax - yMin || 1)) * h

  const todayPath = todayPerCircle.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const baselinePath = baselinePerCircle && baselinePerCircle.length === N
    ? baselinePerCircle.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
    : null

  return wrapSvg({ width, height, content: `
    ${baselinePath ? `<path d="${baselinePath}" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="2 3" opacity="0.65"/>` : ''}
    <path d="${todayPath}" fill="none" stroke="${color}" stroke-width="1.7"/>
    <text x="${pad.left.toFixed(1)}" y="${(height - 2).toFixed(1)}" font-size="8" fill="${CHART_COLORS.axis}">1</text>
    <text x="${(pad.left + w).toFixed(1)}" y="${(height - 2).toFixed(1)}" text-anchor="end" font-size="8" fill="${CHART_COLORS.axis}">${N}</text>
  ` })
}

/* ── trend chart (values over sessions + SMA-7 overlay) ────────────────── */

export function renderTrendChart({ values, sma, color, smaColor, height = 110, width = 348, yLabel }) {
  if (!values || values.length === 0) return emptyMessage('Нет данных', { width, height })
  const pad = { top: 8, right: 6, bottom: 18, left: 22 }
  const w = width - pad.left - pad.right
  const h = height - pad.top - pad.bottom

  const valid = values.filter(v => v !== null && Number.isFinite(v))
  if (valid.length === 0) return emptyMessage('Нет данных', { width, height })

  const yMax = Math.max(...valid) * 1.1
  const yMin = Math.min(0, Math.min(...valid)) * 1.1

  const N = values.length
  const x = i => pad.left + (i / Math.max(1, N - 1)) * w
  const y = v => pad.top + h - ((v - yMin) / (yMax - yMin || 1)) * h

  /* Scatter points (skip nulls). */
  const dots = values.map((v, i) =>
    v !== null && Number.isFinite(v)
      ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2" fill="${color}"/>`
      : '').join('')

  /* SMA polyline (skip nulls — break into segments). */
  let smaPath = ''
  if (sma && sma.length === N) {
    let inSegment = false
    sma.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) { inSegment = false; return }
      smaPath += (inSegment ? 'L' : 'M') + ` ${x(i).toFixed(1)} ${y(v).toFixed(1)} `
      inSegment = true
    })
  }

  return wrapSvg({ width, height, content: `
    ${gridLines(pad, w, h, yMax)}
    ${smaPath ? `<path d="${smaPath}" fill="none" stroke="${smaColor ?? color}" stroke-width="1.5" opacity="0.85"/>` : ''}
    ${dots}
    ${yLabel ? `<text x="${(pad.left - 6).toFixed(1)}" y="${(pad.top + 4).toFixed(1)}" font-size="9" fill="${CHART_COLORS.axis}" text-anchor="end">${escapeHtml(yLabel)}</text>` : ''}
  ` })
}

/* ── scatter with linear regression ────────────────────────────────────── */

export function renderScatter({ points, color = CHART_COLORS.alpha, height = 140, width = 348, xLabel, yLabel, xRange, yRange }) {
  if (!points || points.length === 0) return emptyMessage('Нет данных', { width, height })
  const pad = { top: 6, right: 6, bottom: 22, left: 30 }
  const w = width - pad.left - pad.right
  const h = height - pad.top - pad.bottom

  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  const xMin = xRange?.[0] ?? Math.min(...xs)
  const xMax = xRange?.[1] ?? Math.max(...xs)
  const yMin = yRange?.[0] ?? Math.min(...ys)
  const yMax = yRange?.[1] ?? Math.max(...ys)

  const sx = v => pad.left + ((v - xMin) / (xMax - xMin || 1)) * w
  const sy = v => pad.top + h - ((v - yMin) / (yMax - yMin || 1)) * h

  const dots = points.map(p =>
    `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="${p.highlight ? 3.5 : 2.4}" fill="${color}" ${p.highlight ? `stroke="white" stroke-width="1.2"` : ''}/>`
  ).join('')

  /* Linear regression. */
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length
  let num = 0, den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY)
    den += (xs[i] - meanX) ** 2
  }
  const slope = den !== 0 ? num / den : 0
  const intercept = meanY - slope * meanX
  const lineY = x => slope * x + intercept

  return wrapSvg({ width, height, content: `
    ${gridLines(pad, w, h, yMax)}
    ${den !== 0 ? `<line x1="${sx(xMin).toFixed(1)}" y1="${sy(lineY(xMin)).toFixed(1)}" x2="${sx(xMax).toFixed(1)}" y2="${sy(lineY(xMax)).toFixed(1)}" stroke="${color}" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.55"/>` : ''}
    ${dots}
    ${xLabel ? `<text x="${(pad.left + w / 2).toFixed(1)}" y="${(height - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="${CHART_COLORS.axis}">${escapeHtml(xLabel)}</text>` : ''}
    ${yLabel ? `<text x="${(pad.left - 6).toFixed(1)}" y="${(pad.top - 1).toFixed(1)}" text-anchor="end" font-size="9" fill="${CHART_COLORS.axis}">${escapeHtml(yLabel)}</text>` : ''}
  ` })
}

/* ── box-plot for 3 categorical groups ─────────────────────────────────── */

export function renderBoxPlot({ groups, color = CHART_COLORS.alpha, height = 150, width = 348 }) {
  if (!groups || groups.length === 0) return emptyMessage('Нет данных', { width, height })
  const pad = { top: 10, right: 10, bottom: 24, left: 30 }
  const w = width - pad.left - pad.right
  const h = height - pad.top - pad.bottom

  const allValues = groups
    .flatMap(g => g.n > 0 ? [g.min, g.q1, g.median, g.q3, g.max] : [])
    .filter(v => v !== null && Number.isFinite(v))
  if (allValues.length === 0) return emptyMessage('Нет данных по группам', { width, height })

  const yMax = Math.max(...allValues) * 1.1
  const yMin = Math.min(...allValues, 0) * 1.1
  const sy = v => pad.top + h - ((v - yMin) / (yMax - yMin || 1)) * h

  const colW = w / groups.length
  const boxW = Math.min(36, colW * 0.55)

  let out = gridLines(pad, w, h, yMax)
  groups.forEach((g, idx) => {
    const cx = pad.left + colW * idx + colW / 2
    out += `<text x="${cx.toFixed(1)}" y="${(height - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="${CHART_COLORS.axis}">${escapeHtml(g.label)} (${g.n})</text>`
    if (g.n === 0 || g.median === null) {
      out += `<text x="${cx.toFixed(1)}" y="${(pad.top + h / 2).toFixed(1)}" text-anchor="middle" font-size="9" fill="${CHART_COLORS.axisFaint}">—</text>`
      return
    }
    /* Whiskers. */
    out += `<line x1="${cx.toFixed(1)}" y1="${sy(g.min).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${sy(g.max).toFixed(1)}" stroke="${color}" stroke-width="1"/>`
    /* Cap lines. */
    out += `<line x1="${(cx - boxW / 4).toFixed(1)}" y1="${sy(g.min).toFixed(1)}" x2="${(cx + boxW / 4).toFixed(1)}" y2="${sy(g.min).toFixed(1)}" stroke="${color}" stroke-width="1"/>`
    out += `<line x1="${(cx - boxW / 4).toFixed(1)}" y1="${sy(g.max).toFixed(1)}" x2="${(cx + boxW / 4).toFixed(1)}" y2="${sy(g.max).toFixed(1)}" stroke="${color}" stroke-width="1"/>`
    /* IQR box. */
    out += `<rect x="${(cx - boxW / 2).toFixed(1)}" y="${sy(g.q3).toFixed(1)}" width="${boxW.toFixed(1)}" height="${(sy(g.q1) - sy(g.q3)).toFixed(1)}" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="1"/>`
    /* Median bar. */
    out += `<line x1="${(cx - boxW / 2).toFixed(1)}" y1="${sy(g.median).toFixed(1)}" x2="${(cx + boxW / 2).toFixed(1)}" y2="${sy(g.median).toFixed(1)}" stroke="${color}" stroke-width="1.8"/>`
  })

  return wrapSvg({ width, height, content: out })
}

/* ── primitives ────────────────────────────────────────────────────────── */

function wrapSvg({ width, height, content }) {
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif, system-ui, sans-serif">${content}</svg>`
}

function emptyMessage(text, { width, height }) {
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="11" font-family="ui-sans-serif" fill="${CHART_COLORS.axisFaint}">${escapeHtml(text)}</text>
  </svg>`
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function quantile(arr, q) {
  if (!arr || arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo])
}

function findLongestRun(flags) {
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
