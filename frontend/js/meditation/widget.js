/* Compact "Джапа" widget for the morning dashboard. Five states:
 *   no_sessions     — first run, no Muse data yet
 *   pending_context — uploaded but circles unconfirmed (offer to finish dialog)
 *   stale           — last session >24h, link to most recent
 *   fresh + metrics — last session <24h with three deltas vs 30-day baseline
 *   fresh + noCompareReason — fresh but comparison hidden (preview/excluded/short/long/no_baseline)
 *
 * No evaluative colours per brief — delta sign is plain text, neutral grey. */

import { getJapaSummaryWidget } from './api.js'
import { formatMinSec, plural, escapeHtml as e } from './shared.js'

export const WIDGET_STYLES = `
  .japa-widget {
    border-radius: 16px;
    padding: 14px 16px;
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-backdrop-filter: blur(22px) saturate(140%);
    border: 1px solid rgba(255,255,255,.6);
    background: rgba(255,255,255,.55);
  }
  .japa-widget-head {
    display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
    margin-bottom: 8px;
  }
  .japa-widget-title {
    font-family: 'EB Garamond', Georgia, serif;
    font-size: 18px; line-height: 1.1; color: var(--ink);
  }
  .japa-widget-sub {
    font-size: 11px; color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .japa-widget-metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    margin-top: 8px;
  }
  .japa-metric {
    display: flex; flex-direction: column; gap: 2px;
  }
  .japa-metric-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--text-3);
  }
  .japa-metric-value {
    font-family: 'EB Garamond', Georgia, serif;
    font-size: 22px; line-height: 1; color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .japa-metric-baseline {
    font-size: 11px; color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .japa-metric-delta {
    font-size: 11px; color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .japa-widget-cta {
    display: inline-flex; align-items: center; gap: 4px;
    margin-top: 10px; font-size: 12px;
    color: var(--ink);
    text-decoration: none;
  }
  .japa-widget-cta:hover { text-decoration: underline; }
  .japa-widget-note {
    font-size: 11px; color: var(--text-3); margin-top: 6px;
  }
  .japa-widget-empty-body {
    font-size: 13px; color: var(--text-2); margin-top: 4px;
    line-height: 1.4;
  }
`

export async function mountJapaWidget(container) {
  if (!container) return
  container.innerHTML = `<div class="japa-widget"><div class="japa-widget-title">Джапа</div><div class="japa-widget-empty-body">Загружаю…</div></div>`
  try {
    const data = await getJapaSummaryWidget()
    container.innerHTML = renderWidget(data)
  } catch (err) {
    console.error('widget load failed:', err)
    container.innerHTML = `<div class="japa-widget"><div class="japa-widget-title">Джапа</div><div class="japa-widget-note">Не удалось загрузить виджет.</div></div>`
  }
}

export function renderWidget(data) {
  switch (data.state) {
    case 'no_sessions':     return renderNoSessions()
    case 'pending_context': return renderPending(data)
    case 'stale':           return renderStale(data)
    case 'fresh':           return data.metrics ? renderFreshWithMetrics(data) : renderFreshNoCompare(data)
    default:                return renderNoSessions()
  }
}

function renderNoSessions() {
  return `
    <div class="japa-widget">
      <div class="japa-widget-title">Джапа</div>
      <div class="japa-widget-empty-body">Нет записей. Загрузи CSV в Telegram-бот, чтобы начать.</div>
    </div>`
}

function renderPending(data) {
  const s = data.session
  return `
    <div class="japa-widget">
      <div class="japa-widget-title">Джапа</div>
      <div class="japa-widget-empty-body">Сессия ${e(s.date)}, ${formatDuration(s.durationMin)} — ждёт подтверждения кругов.</div>
      <a class="japa-widget-cta" href="/meditation/sessions.html?id=${e(s.id)}">→ Дозаполнить</a>
    </div>`
}

function renderStale(data) {
  const s = data.session
  return `
    <div class="japa-widget">
      <div class="japa-widget-title">Джапа</div>
      <div class="japa-widget-empty-body">
        Нет свежих данных. Последняя сессия — ${e(s.date)}, ${formatDuration(s.durationMin)},
        ${e(s.circles)} ${plural(s.circles, 'круг', 'круга', 'кругов')}.
      </div>
      <a class="japa-widget-cta" href="/meditation/sessions.html?id=${e(s.id)}">→ Открыть последний отчёт</a>
    </div>`
}

function renderFreshWithMetrics(data) {
  const s = data.session
  const m = data.metrics
  return `
    <a class="japa-widget" href="/meditation/sessions.html?id=${e(s.id)}" style="display: block; text-decoration: none; color: inherit;">
      <div class="japa-widget-head">
        <div class="japa-widget-title">Джапа ${e(s.date)}</div>
        <div class="japa-widget-sub">${formatDuration(s.durationMin)} · ${e(s.circles)} ${plural(s.circles, 'круг', 'круга', 'кругов')}</div>
      </div>
      <div class="japa-widget-metrics">
        ${metricCell('Углубление', m.deepening, '%', { isDelta: true })}
        ${metricCell('Стабильность', m.stability, '')}
        ${metricCell('Calm', m.longestCalm, '', { asTime: true })}
      </div>
      <span class="japa-widget-cta" style="text-decoration: underline;">→ Подробный отчёт</span>
    </a>`
}

function renderFreshNoCompare(data) {
  const s = data.session
  const note = {
    preview:               'Только посмотреть · сравнение не показывается',
    manual_exclude:        'Сессия исключена из статистики · сравнение не показывается',
    nonstandard_duration:  data.session && data.session.durationMin < 45
      ? 'Сегодня короче обычной · сравнение пропущено'
      : 'Сегодня длиннее обычной · сравнение пропущено',
    no_baseline:           `Сравнение появится после 5 сессий. (Сейчас в базе: ${data.baselineSessionCount})`,
  }[data.noCompareReason] ?? ''
  return `
    <a class="japa-widget" href="/meditation/sessions.html?id=${e(s.id)}" style="display: block; text-decoration: none; color: inherit;">
      <div class="japa-widget-head">
        <div class="japa-widget-title">Джапа ${e(s.date)}</div>
        <div class="japa-widget-sub">${formatDuration(s.durationMin)} · ${e(s.circles)} ${plural(s.circles, 'круг', 'круга', 'кругов')}</div>
      </div>
      ${note ? `<div class="japa-widget-note">${e(note)}</div>` : ''}
      <span class="japa-widget-cta" style="text-decoration: underline;">→ Подробный отчёт</span>
    </a>`
}

function metricCell(label, metric, unit, { isDelta = false, asTime = false } = {}) {
  const today = metric.today
  const baseline = metric.baseline
  const delta = metric.deltaPct
  return `
    <div class="japa-metric">
      <div class="japa-metric-label">${e(label)}</div>
      <div class="japa-metric-value">${formatToday(today, unit, { isDelta, asTime })}</div>
      <div class="japa-metric-baseline">ср.30д: ${formatBaseline(baseline, unit, { isDelta, asTime })}</div>
      ${delta !== null && delta !== undefined ? `<div class="japa-metric-delta">${formatDeltaForCell(delta, today, baseline, asTime)}</div>` : ''}
    </div>`
}

function formatToday(v, unit, { isDelta, asTime }) {
  if (v === null || v === undefined) return '—'
  if (asTime) return formatMinSec(v)
  if (isDelta) return `${v >= 0 ? '+' : ''}${Math.round(v)}${unit}`
  return formatNum(v) + unit
}

function formatBaseline(v, unit, { isDelta, asTime }) {
  if (v === null || v === undefined) return '—'
  if (asTime) return formatMinSec(v)
  if (isDelta) return `${v >= 0 ? '+' : ''}${Math.round(v)}${unit}`
  return formatNum(v) + unit
}

function formatDeltaForCell(deltaPct, today, baseline, asTime) {
  /* For time-based metric the delta-percentage is awkward — show absolute diff in M:SS. */
  if (asTime) {
    const diff = today - baseline
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : ''
    return `${sign}${formatMinSec(Math.abs(diff))}`
  }
  return `${deltaPct >= 0 ? '+' : ''}${formatNum(deltaPct)}%`
}

function formatNum(v) {
  if (v === null || v === undefined) return '—'
  /* Drop trailing zeros: 60.0 → "60", 60.6 → "60,6", 3.01 → "3,01". */
  if (Math.abs(v) >= 100 || Math.abs(v - Math.round(v)) < 0.05) {
    return Math.round(v).toString()
  }
  if (Math.abs(v) >= 10) return v.toFixed(1).replace('.', ',')
  return v.toFixed(2).replace('.', ',')
}

function formatDuration(min) {
  if (min === null || min === undefined) return '—'
  return `${formatNum(min)} мин`
}
