/* Renderer for /meditation/sessions.html — assembles every section of SessionReport
 * into one DOM tree under #root. Pure data-in, HTML-out (except for the small action
 * handlers that mutate state via toggleSessionExclusion). */

import {
  PageHead, SectionTitle, Chip, Tag, ClaudeBlock, ContextBlock,
  SparseNote, StatMini, DeltaChip, Card, formatMinSec, plural,
  escapeHtml as e, STYLES as ATOMS_STYLES,
} from './shared.js'
import {
  renderMainChart, renderCalmStrip, renderComparePerCircle, CHART_COLORS, ChartLegend,
} from './charts.js'
import { toggleSessionExclusion } from './api.js'

const VARIANT_KEY = 'panditji_main_chart_variant'

export function renderSession(root, report) {
  const variant = localStorage.getItem(VARIANT_KEY) ?? 'bars'
  root.innerHTML = `
    ${PageHead({
      title: 'Сессия',
      meta: `${report.date.split(',')[0]} · ${report.time.start}`,
      backHref: '/morning.html',
    })}
    ${stateBadges(report)}
    ${titleBlock(report)}
    ${signalCard(report)}
    ${mainChartCard(report, variant)}
    ${calmStripCard(report)}
    ${phasesCard(report)}
    ${noteAndTagsCard(report)}
    ${compareCard(report)}
    ${statsLink()}
    ${actionsRow(report)}
  `
  bindActions(root, report)
}

/* ── state badges (preview / excluded / headband shift / nonstandard duration) ── */

function stateBadges(report) {
  const badges = []
  if (report.signal.shift) {
    badges.push(Card({
      tone: 'terra',
      children: `
        <div class="text-[13px] c-terra-deep leading-snug">
          <strong>Заметна смена сигнала на ${report.signal.shift.atMinute}-й минуте.</strong>
          Возможно, повязка сдвинулась — метрики углубления для этой сессии недостоверны.
        </div>`,
    }))
  }
  if (report.kind === 'preview') {
    badges.push(Card({
      tone: 'gold',
      children: `<div class="text-[13px] c-gold-deep">Только посмотреть · не учитывается в статистике</div>`,
    }))
  } else if (report.excludedFromStats) {
    badges.push(Card({
      tone: 'gold',
      children: `<div class="text-[13px] c-gold-deep">Исключена из статистики</div>`,
    }))
  }
  if (report.durationCategory === 'short' || report.durationCategory === 'long') {
    const label = report.durationCategory === 'short' ? 'Короче обычной' : 'Длиннее обычной'
    badges.push(Card({
      children: `<div class="text-[12px] c-text-2">${e(label)}${report.durationVsMedianPct !== null ? ` (${formatDelta(report.durationVsMedianPct)}%)` : ''}</div>`,
    }))
  }
  return badges.length > 0 ? `<div class="space-y-2 mb-3">${badges.join('')}</div>` : ''
}

/* ── title block: big date + meta row + chips ─────────────────────────── */

function titleBlock(report) {
  const chips = []
  if (report.location?.name) chips.push(Chip({ children: report.location.name, tone: 'sage' }))
  if (report.context.distracted) chips.push(Chip({ children: `отвлекали: ${report.context.distracted}`, tone: 'default' }))
  if (report.context.selfRating !== null) chips.push(Chip({ children: `оценка ${report.context.selfRating}/5`, tone: 'default' }))
  if (report.context.whoopSleep) chips.push(Chip({ children: `спал ${report.context.whoopSleep}`, tone: 'sage' }))
  if (report.context.whoopRecovery !== null) chips.push(Chip({ children: `recovery ${report.context.whoopRecovery}%`, tone: 'sage' }))

  const paceStr = report.paceMinPerCircle
    ? `${report.durationMin.toFixed(1).replace('.', ',')} мин · ${report.circles} кругов · ${report.paceMinPerCircle.toString().replace('.', ',')} мин/круг`
    : `${report.durationMin.toFixed(1).replace('.', ',')} мин`

  return `
    <section class="mb-4">
      <h2 class="font-serif-m c-ink text-[26px] leading-tight">${e(report.date)}</h2>
      <div class="text-[12px] c-text-2 mt-1 num">${e(report.time.start)}–${e(report.time.end)} · ${e(paceStr)}</div>
      ${chips.length > 0 ? `<div class="flex flex-wrap gap-1.5 mt-2">${chips.join('')}</div>` : ''}
    </section>`
}

/* ── signal card ──────────────────────────────────────────────────────── */

function signalCard(report) {
  const sig = report.signal
  const chips = ['TP9', 'AF7', 'AF8', 'TP10']
    .map(n => Chip({
      children: n,
      tone: sig.electrodes[n] === 'ok' ? 'sage' : sig.electrodes[n] === 'warn' ? 'gold' : 'terra',
    }))
    .join('')
  return Card({
    children: `
      ${SectionTitle({ children: 'Сигнал' })}
      <div class="flex items-baseline justify-between gap-3 mt-1">
        <div>
          <span class="font-serif-m c-ink text-[22px] num">${e(Math.round(sig.overall))}%</span>
          <span class="text-[11px] c-text-3 ml-1">хор. сигнала</span>
        </div>
        <span class="text-[11px] c-text-3">артефакты: ${e(sig.artifacts)}</span>
      </div>
      <div class="flex flex-wrap gap-1.5 mt-2">${chips}</div>
    `,
    extraClass: 'mb-3',
  })
}

/* ── main chart card (with variant switcher) ──────────────────────────── */

function mainChartCard(report, variant) {
  if (!report.perCircle || report.perCircle.length === 0) {
    return Card({
      children: `
        ${SectionTitle({ children: 'Динамика по кругам' })}
        <div class="text-[13px] c-text-2 mt-2">Подтверди число кругов в Telegram-боте, и анализ откроется.</div>`,
      extraClass: 'mb-3',
    })
  }

  const variants = [
    { key: 'bars', label: 'столбики' },
    { key: 'stream', label: 'поток' },
    { key: 'lines', label: 'линии' },
  ]
  const switcher = `
    <div class="chart-form-switch" role="tablist">
      ${variants.map(v =>
        `<button type="button" data-action="set-variant" data-variant="${v.key}"
                 class="form-switch-btn ${v.key === variant ? 'active' : ''}">${e(v.label)}</button>`,
      ).join('')}
    </div>`

  const legend = ChartLegend({ items: [
    { label: 'Alpha', color: CHART_COLORS.alpha },
    { label: 'Theta', color: CHART_COLORS.theta },
    { label: 'Beta', color: CHART_COLORS.beta, faded: true },
  ]})

  return Card({
    children: `
      <div class="flex items-center justify-between gap-2">
        ${SectionTitle({ children: 'Динамика по кругам' })}
        ${switcher}
      </div>
      <div class="mt-2">${legend}</div>
      <div id="main-chart" class="mt-2">${renderMainChart(report.perCircle, variant)}</div>
      ${report.caption?.main ? `<div class="mt-2">${ClaudeBlock({ eyebrow: 'наблюдение', body: report.caption.main })}</div>` : ''}
    `,
    extraClass: 'mb-3',
  })
}

/* ── calm strip card ──────────────────────────────────────────────────── */

function calmStripCard(report) {
  if (!report.perCircle || report.perCircle.length === 0) return ''
  /* perCircle objects have alpha/theta/beta, but no ab. We approximate ab as
   * alpha/beta for the heatmap threshold — close enough for the visual cue;
   * the actual longest_calm number from the API is authoritative below. */
  const augmented = report.perCircle.map(c => ({ ...c, ab: c.beta > 0 ? c.alpha / c.beta : 0 }))
  const abValues = augmented.map(c => c.ab)

  const longestStr = report.longestCalmSec
    ? `${formatMinSec(report.longestCalmSec)}${report.calmPeriodsCount ? ` · ${report.calmPeriodsCount} ${plural(report.calmPeriodsCount, 'отрезок', 'отрезка', 'отрезков')} ≥ 60 сек` : ''}`
    : '—'

  return Card({
    children: `
      <div class="flex items-center justify-between gap-2">
        ${SectionTitle({ children: 'Спокойные отрезки' })}
        <span class="text-[10px] c-text-3 uppercase tracking-eyebrow">порог: верхняя четверть A/B</span>
      </div>
      <div class="mt-2">${renderCalmStrip(augmented, abValues)}</div>
      ${report.caption?.calm ? `<div class="mt-2">${SparseNote({ children: report.caption.calm })}</div>` : `<div class="mt-2 text-[12px] c-text-2 num">Самый длинный отрезок: ${e(longestStr)}</div>`}
    `,
    extraClass: 'mb-3',
  })
}

/* ── phases card ──────────────────────────────────────────────────────── */

function phasesCard(report) {
  if (!report.phases || report.phases.length === 0) return ''
  const rows = report.phases.map(p => `
    <div class="phase-row">
      <div class="flex items-baseline gap-2">
        <span class="font-serif-m c-ink text-[16px]">${e(p.label)}</span>
        <span class="text-[11px] c-text-3 num">круги ${p.range[0]}–${p.range[1]}</span>
      </div>
      <div class="text-[13px] c-text-2 mt-0.5 leading-snug">${e(p.note)}</div>
    </div>`).join('<div class="phase-sep"></div>')
  return Card({
    children: `${SectionTitle({ children: 'Фазы' })}<div class="mt-2 space-y-2">${rows}</div>`,
    extraClass: 'mb-3',
  })
}

/* ── note + tags card ─────────────────────────────────────────────────── */

function noteAndTagsCard(report) {
  if ((!report.context.userNote || !report.context.userNote.trim()) && (!report.tags || report.tags.length === 0)) {
    return ''
  }
  return Card({
    children: `
      ${SectionTitle({ children: 'Заметка и теги' })}
      ${report.context.userNote ? `
        <blockquote class="font-serif-m italic c-text mt-2 text-[14px] leading-relaxed">«${e(report.context.userNote)}»</blockquote>
      ` : ''}
      ${report.tags && report.tags.length > 0 ? `
        <div class="flex flex-wrap gap-1.5 mt-2">${report.tags.map(t => Tag({ children: t })).join('')}</div>
      ` : ''}
    `,
    extraClass: 'mb-3',
  })
}

/* ── compare with self (3 per-circle rows) ────────────────────────────── */

function compareCard(report) {
  const c = report.compare
  if (!report.perCircle || report.perCircle.length === 0) return ''

  /* Pick a representative period — m (30 days) is the dashboard default.
   * Falls back to the first available one if m is null. */
  const pickRow = (metric) => {
    const periods = c[metric].periods
    return periods.m ?? periods.w ?? periods.q ?? periods.all ?? null
  }

  const rows = [
    { key: 'deepening', label: 'Углубление Theta',     color: CHART_COLORS.theta, unit: '%' },
    { key: 'stability', label: 'Стабильность A/B',     color: CHART_COLORS.alpha, unit: '' },
    { key: 'beta',      label: 'Beta — фон беспокойства', color: CHART_COLORS.beta, unit: '%' },
  ]

  let hint = ''
  if (c.deepening.hiddenReason === 'preview')           hint = 'Только посмотреть · сравнение не показывается'
  else if (c.deepening.hiddenReason === 'manual_exclude') hint = 'Сессия исключена из статистики · сравнение не показывается'
  else if (c.deepening.hiddenReason === 'nonstandard_duration') hint = `Сессия ${report.durationCategory === 'short' ? 'короче' : 'длиннее'} обычной — сравнения с baseline пропущены, чтобы не сравнивать физиологически разное`
  else if (c.deepening.hiddenReason === 'no_baseline')  hint = 'Сравнения появятся после 5 сессий в базе'

  const body = rows.map(({ key, label, color, unit }) => {
    const metric = c[key]
    const period = pickRow(key)
    const todayVal = metric.todayValue
    const sub = period
      ? `<span class="text-[11px] c-text-3 num">ср.30д: ${formatVal(period.baselineValue)}${unit}</span>`
      : ''
    const delta = period
      ? DeltaChip({ value: period.deltaPct, unit: unit ? '%' : '' })
      : ''

    return `
      <div class="compare-row">
        <div class="flex items-baseline justify-between gap-2">
          <div class="text-[13px] c-ink font-semibold">${e(label)}</div>
          <div class="flex items-baseline gap-2">
            <span class="font-serif-m c-ink num text-[20px]">${formatVal(todayVal)}${unit ? `<span class="text-[12px] c-text-3 ml-0.5">${unit}</span>` : ''}</span>
            ${delta}
          </div>
        </div>
        <div class="text-right text-[11px] c-text-3 num mt-0.5">${sub}</div>
        <div class="mt-1">
          ${renderComparePerCircle({
            todayPerCircle: metric.todayPerCircle,
            baselinePerCircle: period?.baselinePerCircle ?? null,
            color,
          })}
        </div>
      </div>`
  }).join('<div class="phase-sep"></div>')

  return Card({
    children: `
      ${SectionTitle({ children: 'Сравнение с собой' })}
      <div class="mt-2 space-y-2">${body}</div>
      ${hint ? `<div class="text-[11px] c-text-3 mt-2 italic">${e(hint)}</div>` : ''}
    `,
    extraClass: 'mb-3',
  })
}

/* ── statistics link ──────────────────────────────────────────────────── */

function statsLink() {
  return `
    <a href="/meditation/trends.html" class="block stats-cta mb-3">
      <span class="text-[13px] c-ink font-semibold">Статистика</span>
      <span class="text-[11px] c-text-3">тренды, корреляции →</span>
    </a>`
}

/* ── actions row ──────────────────────────────────────────────────────── */

function actionsRow(report) {
  const isExcluded = report.excludedFromStats
  const excludeLabel =
    report.kind === 'preview' ? 'Включить в статистику' :
    isExcluded ? 'Включить в статистику' : 'Исключить из статистики'
  return `
    <div class="flex items-center gap-2 mb-6">
      <button class="action-btn" data-action="toggle-exclude" data-current="${isExcluded}">${e(excludeLabel)}</button>
    </div>`
}

/* ── event delegation ─────────────────────────────────────────────────── */

function bindActions(root, report) {
  if (root._delegated) return
  root._delegated = true
  root.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action

    if (action === 'set-variant') {
      const variant = btn.dataset.variant
      localStorage.setItem(VARIANT_KEY, variant)
      const container = root.querySelector('#main-chart')
      if (container) container.innerHTML = renderMainChart(report.perCircle, variant)
      root.querySelectorAll('[data-action="set-variant"]').forEach(b => {
        b.classList.toggle('active', b.dataset.variant === variant)
      })
      return
    }

    if (action === 'toggle-exclude') {
      const current = btn.dataset.current === 'true'
      btn.disabled = true
      btn.style.opacity = '0.6'
      try {
        await toggleSessionExclusion(report.id, !current)
        location.reload()
      } catch (e) {
        alert('Не получилось: ' + (e?.message ?? 'ошибка'))
        btn.disabled = false
        btn.style.opacity = '1'
      }
    }
  })
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function formatVal(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (Math.abs(v) >= 100) return Math.round(v).toString()
  if (Math.abs(v) >= 10) return v.toFixed(1).replace('.', ',')
  return v.toFixed(2).replace('.', ',')
}

function formatDelta(v) {
  if (v === null || v === undefined) return '0'
  return (v >= 0 ? '+' : '') + v.toFixed(1).replace('.', ',')
}

/* ── stylesheet block (exported so the HTML page embeds it once) ──────── */

export const SESSION_STYLES = `
  ${ATOMS_STYLES}

  .chart-form-switch {
    display: inline-flex;
    background: rgba(255,255,255,.45);
    border: 1px solid rgba(255,255,255,.55);
    border-radius: 999px;
    padding: 2px;
  }
  .form-switch-btn {
    font-size: 11px;
    padding: 4px 9px;
    border-radius: 999px;
    color: var(--text-2);
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .form-switch-btn.active {
    background: var(--ink-2);
    color: white;
  }

  .phase-row { padding: 4px 0; }
  .phase-sep {
    height: 1px;
    background: rgba(50, 58, 85, 0.08);
    margin: 6px 0;
  }
  .compare-row { padding: 4px 0; }

  .stats-cta {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px;
    border-radius: 14px;
    background: rgba(255,255,255,.45);
    border: 1px solid rgba(255,255,255,.55);
  }
  .stats-cta:hover { background: rgba(255,255,255,.7); }

  .action-btn {
    font-size: 12px;
    padding: 8px 14px;
    border-radius: 999px;
    color: var(--ink);
    background: rgba(255,255,255,.55);
    border: 1px solid rgba(255,255,255,.55);
    cursor: pointer;
  }
  .action-btn:hover { background: rgba(255,255,255,.75); }
`
