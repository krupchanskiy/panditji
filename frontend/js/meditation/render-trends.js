/* Renderer for /meditation/trends.html — assembles TrendsReport into the stats screen:
 *   summary row, two trend charts (deepening + stability), four correlation cards.
 *
 * The page owns state (period + calmOnly) and re-fetches on change. */

import {
  PageHead, SectionTitle, Card, StatMini, SparseNote, ClaudeBlock, ContextBlock,
  escapeHtml as e, STYLES as ATOMS_STYLES, plural,
} from './shared.js'
import {
  renderTrendChart, renderScatter, renderBoxPlot, CHART_COLORS,
} from './charts.js'
import { getTrendsReport } from './api.js'

const PERIOD_OPTIONS = [
  { key: 7,   label: '7д' },
  { key: 30,  label: '30д' },
  { key: 90,  label: '90д' },
  { key: 365, label: 'всё' },
]

const state = {
  period: 30,
  calmOnly: true,
  report: null,
  loading: false,
}

export async function bootstrapTrends(root) {
  bindActions(root)
  await loadAndRender(root)
}

async function loadAndRender(root) {
  state.loading = true
  renderShell(root)
  try {
    state.report = await getTrendsReport(state.period, state.calmOnly)
    state.loading = false
    renderShell(root)
  } catch (err) {
    state.loading = false
    root.innerHTML = `
      ${PageHead({ title: 'Статистика', meta: 'ошибка загрузки', backHref: '/morning.html' })}
      <div class="text-[13px] c-text-2 py-8 text-center">
        Не получилось загрузить: ${e(err?.message ?? 'ошибка')}
      </div>`
  }
}

export function renderTrends(root, report) {
  state.report = report
  state.loading = false
  bindActions(root)
  renderShell(root)
}

function renderShell(root) {
  const periodMeta = `${state.period === 365 ? 'всё время' : `${state.period} дней`}`

  root.innerHTML = `
    ${PageHead({ title: 'Статистика', meta: periodMeta, backHref: '/morning.html' })}
    ${calmToggle()}
    ${periodSwitch()}
    ${state.loading ? loadingRow() : (state.report ? renderBody(state.report) : '')}
  `
}

function loadingRow() {
  return `<div class="text-[13px] c-text-3 py-8 text-center">Загружаю…</div>`
}

/* ── period + calm toggle ──────────────────────────────────────────────── */

function calmToggle() {
  return `
    <div class="calm-toggle-row mb-3">
      <label class="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" data-action="toggle-calm" ${state.calmOnly ? 'checked' : ''}/>
        <span class="text-[13px] c-ink">Только спокойная джапа</span>
      </label>
    </div>`
}

function periodSwitch() {
  return `
    <div class="period-switch mb-3">
      ${PERIOD_OPTIONS.map(o => `
        <button type="button"
                data-action="set-period" data-period="${o.key}"
                class="period-btn ${o.key === state.period ? 'active' : ''}">${e(o.label)}</button>
      `).join('')}
    </div>`
}

/* ── body sections ─────────────────────────────────────────────────────── */

function renderBody(report) {
  return `
    ${summaryCard(report)}
    ${trendCard({
      title: 'Углубление Theta',
      values: report.sessions.map(s => s.deepening),
      sma: report.sma7Deepening,
      color: CHART_COLORS.theta,
      caption: report.correlations?.sleepVsDeepening?.interpretation,
      yLabel: '%',
    })}
    ${trendCard({
      title: 'Стабильность A/B',
      values: report.sessions.map(s => s.ab),
      sma: report.sma7Ab,
      color: CHART_COLORS.alpha,
      yLabel: 'A/B',
    })}
    ${SectionTitle({ children: 'Корреляции' })}
    <div class="mt-2 space-y-3 mb-3">
      ${scatterCard({
        title: 'Сон → углубление',
        points: report.sessions
          .filter(s => s.sleep !== null && s.deepening !== null)
          .map(s => ({ x: s.sleep, y: s.deepening, highlight: s.isToday })),
        color: CHART_COLORS.theta,
        xLabel: 'часы сна',
        yLabel: '%',
        interpretation: report.correlations?.sleepVsDeepening?.interpretation,
      })}
      ${scatterCard({
        title: 'Recovery → стабильность A/B',
        points: report.sessions
          .filter(s => s.recovery !== null)
          .map(s => ({ x: s.recovery, y: s.ab, highlight: s.isToday })),
        color: CHART_COLORS.alpha,
        xLabel: 'recovery %',
        yLabel: 'A/B',
        interpretation: report.correlations?.recoveryVsStability?.interpretation,
      })}
      ${boxPlotCard({
        title: 'Отвлекали → углубление',
        boxPlot: report.correlations?.distractedVsDeepening,
        color: CHART_COLORS.theta,
        note: 'Здесь учтены все сессии — фильтр «только спокойная» не применяется, иначе колонка «сильно» оказалась бы пустой.',
      })}
      ${scatterCard({
        title: 'Самооценка vs A/B',
        points: report.sessions
          .filter(s => s.rating !== null)
          .map(s => ({ x: s.rating, y: s.ab, highlight: s.isToday })),
        color: CHART_COLORS.alpha,
        xLabel: 'оценка 1-5',
        yLabel: 'A/B',
        xRange: [0.5, 5.5],
        interpretation: report.correlations?.selfRatingVsAb?.interpretation,
      })}
    </div>
    ${aboutCorrelations()}
  `
}

function summaryCard(report) {
  const totalMin = Math.round(report.totalMinutes)
  const totalHours = Math.floor(totalMin / 60)
  const totalRemMin = totalMin % 60
  const timeStr = totalHours > 0 ? `${totalHours} ч ${totalRemMin} м` : `${totalRemMin} м`
  const sessionsLabel = `${report.total} ${plural(report.total, 'сессия', 'сессии', 'сессий')}`

  return Card({
    extraClass: 'mb-3',
    children: `
      ${SectionTitle({ children: `За последние ${state.period === 365 ? 'всё время' : `${state.period} дней`}` })}
      <div class="summary-grid mt-2">
        ${StatMini({ value: report.total, label: sessionsLabel })}
        ${StatMini({ value: timeStr, label: 'в практике' })}
        ${StatMini({ value: report.avgDuration ?? '—', label: 'ср. длит., мин', unit: '' })}
        ${StatMini({ value: report.avgPerCircle ?? '—', label: 'ср/круг, мин' })}
        ${StatMini({ value: report.goodSignalPercent ? Math.round(report.goodSignalPercent) + '%' : '—', label: 'хор. сигнал' })}
      </div>
    `,
  })
}

function trendCard({ title, values, sma, color, caption, yLabel }) {
  const hasData = values.some(v => v !== null && Number.isFinite(v))
  return Card({
    extraClass: 'mb-3',
    children: `
      ${SectionTitle({ children: title })}
      <div class="mt-2">${hasData ? renderTrendChart({ values, sma, color, smaColor: color, yLabel }) : '<div class="text-[12px] c-text-3 py-6 text-center">Нет данных за период</div>'}</div>
      ${caption ? `<div class="mt-2">${ClaudeBlock({ eyebrow: 'наблюдение', body: caption })}</div>` : ''}
    `,
  })
}

function scatterCard({ title, points, color, xLabel, yLabel, xRange, interpretation }) {
  return Card({
    children: `
      <div class="text-[13px] c-ink font-semibold">${e(title)}</div>
      <div class="mt-2">${
        points.length > 0
          ? renderScatter({ points, color, xLabel, yLabel, xRange })
          : '<div class="text-[12px] c-text-3 py-6 text-center">Нет данных</div>'
      }</div>
      ${interpretation ? `<div class="mt-2 text-[12px] c-text-2">${e(interpretation)}</div>` : ''}
    `,
  })
}

function boxPlotCard({ title, boxPlot, color, note }) {
  if (!boxPlot) return ''
  return Card({
    children: `
      <div class="text-[13px] c-ink font-semibold">${e(title)}</div>
      <div class="mt-2">${renderBoxPlot({ groups: boxPlot.groups, color })}</div>
      ${boxPlot.interpretation ? `<div class="mt-2 text-[12px] c-text-2">${e(boxPlot.interpretation)}</div>` : ''}
      ${note ? `<div class="mt-1 text-[11px] c-text-3 italic">${e(note)}</div>` : ''}
    `,
  })
}

function aboutCorrelations() {
  return ContextBlock({
    heading: 'О корреляциях',
    body: 'Расчёт по Спирмену — устойчиво к нелинейным монотонным зависимостям и редким выбросам. ' +
      'Значимой считается связь с |r| > 0.3 при n ≥ 14. ' +
      'Корреляция не значит причинность — это сигнал «здесь стоит присмотреться», не вывод.',
  })
}

/* ── event delegation ─────────────────────────────────────────────────── */

function bindActions(root) {
  if (root._delegated) return
  root._delegated = true
  root.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    if (action === 'set-period') {
      const next = Number(btn.dataset.period)
      if (next && next !== state.period) {
        state.period = next
        await loadAndRender(root)
      }
    }
  })
  root.addEventListener('change', async (ev) => {
    const el = ev.target.closest('[data-action="toggle-calm"]')
    if (!el) return
    state.calmOnly = el.checked
    await loadAndRender(root)
  })
}

/* ── styles for trends-specific bits ─────────────────────────────────── */

export const TRENDS_STYLES = `
  ${ATOMS_STYLES}

  .calm-toggle-row input[type="checkbox"] {
    appearance: none;
    width: 36px; height: 20px; border-radius: 999px;
    background: rgba(50, 58, 85, 0.18);
    position: relative; cursor: pointer; transition: background 0.15s;
  }
  .calm-toggle-row input[type="checkbox"]::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; border-radius: 999px;
    background: white; transition: left 0.15s;
  }
  .calm-toggle-row input[type="checkbox"]:checked {
    background: var(--sage-deep, oklch(0.52 0.085 235));
  }
  .calm-toggle-row input[type="checkbox"]:checked::after { left: 18px; }

  .period-switch {
    display: inline-flex;
    background: rgba(255,255,255,.5);
    border: 1px solid rgba(255,255,255,.5);
    border-radius: 999px;
    padding: 2px;
  }
  .period-btn {
    font-size: 12px;
    padding: 5px 12px;
    border-radius: 999px;
    color: var(--text-2);
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .period-btn.active {
    background: var(--ink-2);
    color: white;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 14px 18px;
  }
  @media (min-width: 360px) {
    .summary-grid { grid-template-columns: repeat(3, 1fr); }
  }
`
