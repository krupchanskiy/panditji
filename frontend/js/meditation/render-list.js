/* Renderer for /meditation/index.html — the sessions list with filters.
 *
 * Filter state lives in the page; each change refetches and re-renders. */

import {
  PageHead, SectionTitle, Chip, Tag, Card, SparseNote,
  escapeHtml as e, STYLES as ATOMS_STYLES, plural, formatMinSec,
} from './shared.js'
import { getSessionsList } from './api.js'

const PERIOD_OPTIONS = [
  { key: 7,   label: '7д' },
  { key: 30,  label: '30д' },
  { key: 90,  label: '90д' },
  { key: 365, label: 'всё' },
]

const state = {
  period: 90,
  tag: null,
  locationId: null,
  calmOnly: false,
  includeExcluded: false,
  data: null,
  loading: false,
}

export async function bootstrapList(root) {
  bindActions(root)
  await loadAndRender(root)
}

async function loadAndRender(root) {
  state.loading = true
  renderShell(root)
  try {
    state.data = await getSessionsList({
      period: state.period,
      tag: state.tag,
      locationId: state.locationId,
      calmOnly: state.calmOnly,
      includeExcluded: state.includeExcluded,
    })
    state.loading = false
    renderShell(root)
  } catch (err) {
    state.loading = false
    root.innerHTML = `
      ${PageHead({ title: 'Сессии', meta: 'ошибка', backHref: '/morning.html' })}
      <div class="text-[13px] c-text-2 py-8 text-center">
        Не получилось загрузить: ${e(err?.message ?? 'ошибка')}
      </div>`
  }
}

function renderShell(root) {
  const meta = state.data ? `${state.data.total} ${plural(state.data.total, 'сессия', 'сессии', 'сессий')}` : ''
  root.innerHTML = `
    ${PageHead({ title: 'Сессии', meta, backHref: '/morning.html' })}
    ${filtersBlock()}
    ${state.loading
      ? `<div class="text-[13px] c-text-3 py-8 text-center">Загружаю…</div>`
      : (state.data ? renderBody(state.data) : '')
    }
  `
}

function filtersBlock() {
  return `
    <div class="period-switch mb-3">
      ${PERIOD_OPTIONS.map(o => `
        <button type="button" data-action="set-period" data-period="${o.key}"
                class="period-btn ${o.key === state.period ? 'active' : ''}">${e(o.label)}</button>
      `).join('')}
    </div>

    <div class="list-toggles mb-3">
      <label class="list-toggle">
        <input type="checkbox" data-action="toggle-calm" ${state.calmOnly ? 'checked' : ''}/>
        <span>Только спокойная</span>
      </label>
      <label class="list-toggle">
        <input type="checkbox" data-action="toggle-excluded" ${state.includeExcluded ? 'checked' : ''}/>
        <span>Показать исключённые</span>
      </label>
    </div>

    ${facetFilters()}
  `
}

function facetFilters() {
  if (!state.data) return ''
  const { tags, locations } = state.data.facets
  if (tags.length === 0 && locations.length === 0) return ''

  return `
    <details class="filters-details mb-3" ${(state.tag || state.locationId) ? 'open' : ''}>
      <summary class="filters-summary">
        <span class="text-[11px] uppercase tracking-eyebrow c-text-3 font-semibold">Фильтры</span>
        ${(state.tag || state.locationId) ? `
          <button type="button" data-action="clear-facets" class="filters-clear">сбросить</button>
        ` : ''}
      </summary>
      <div class="filters-body">
        ${locations.length > 0 ? `
          <div class="text-[10px] uppercase tracking-eyebrow c-text-3 font-semibold mt-2 mb-1">Место</div>
          <div class="ctx-pillrow">
            ${locations.map(l => `
              <button type="button" class="ctx-pill ${state.locationId === l.id ? 'active' : ''}"
                      data-action="filter-location" data-value="${e(l.id)}">${e(l.name)}</button>
            `).join('')}
          </div>
        ` : ''}
        ${tags.length > 0 ? `
          <div class="text-[10px] uppercase tracking-eyebrow c-text-3 font-semibold mt-3 mb-1">Тег</div>
          <div class="ctx-pillrow">
            ${tags.map(t => `
              <button type="button" class="ctx-pill ${state.tag === t ? 'active' : ''}"
                      data-action="filter-tag" data-value="${e(t)}">${e(t)}</button>
            `).join('')}
          </div>
        ` : ''}
      </div>
    </details>
  `
}

function renderBody(data) {
  if (data.sessions.length === 0) {
    return `
      <div class="py-12 text-center">
        ${SparseNote({ children: 'Под эти фильтры сессий нет.' })}
      </div>`
  }
  return `<div class="session-list">${data.sessions.map(sessionCard).join('')}</div>`
}

function sessionCard(s) {
  const url = `/meditation/sessions.html?id=${encodeURIComponent(s.id)}`
  const metaTop = [
    s.location?.name ?? null,
    s.distracted ? `отвлекали: ${s.distracted}` : null,
    s.selfRating !== null ? `оценка ${s.selfRating}` : null,
  ].filter(Boolean).join(' · ')

  const metrics = []
  if (s.deepeningPct !== null) {
    metrics.push({ label: 'Theta', value: formatDelta(s.deepeningPct), unit: '%' })
  } else if (s.signalShiftSeverity) {
    metrics.push({ label: 'Theta', value: '—', unit: '', subnote: 'артефакт' })
  }
  metrics.push({ label: 'A/B', value: formatNum(s.abIndexMedian), unit: '' })
  if (s.longestCalmSec) {
    metrics.push({ label: 'Calm', value: formatMinSec(s.longestCalmSec), unit: '' })
  }

  const stateChips = []
  if (s.kind === 'preview') stateChips.push(Chip({ children: 'preview', tone: 'gold' }))
  else if (s.excludedFromStats) stateChips.push(Chip({ children: 'исключена', tone: 'gold' }))
  if (s.durationCategory === 'short') stateChips.push(Chip({ children: 'короче обычной', tone: 'default' }))
  else if (s.durationCategory === 'long') stateChips.push(Chip({ children: 'длиннее обычной', tone: 'default' }))

  const tagsRow = s.tags && s.tags.length > 0
    ? `<div class="flex flex-wrap gap-1 mt-2">${s.tags.slice(0, 4).map(t => Tag({ children: t })).join('')}</div>`
    : ''

  const headlineLeft = `
    <div class="flex items-baseline gap-2">
      <span class="font-serif-m c-ink text-[18px]">${e(s.date)}</span>
      <span class="num text-[11px] c-text-3">${e(s.time)} · ${formatNum(s.durationMin)} мин${s.circles ? ` · ${e(s.circles)} ${plural(s.circles, 'круг', 'круга', 'кругов')}` : ''}</span>
    </div>`

  const metricsHtml = metrics.map(m => `
    <div class="session-metric">
      <span class="session-metric-label">${e(m.label)}</span>
      <span class="num c-ink">${e(m.value)}${m.unit ? `<span class="text-[10px] c-text-3 ml-0.5">${e(m.unit)}</span>` : ''}</span>
      ${m.subnote ? `<span class="text-[10px] c-text-3">${e(m.subnote)}</span>` : ''}
    </div>`).join('')

  return `
    <a href="${e(url)}" class="session-card-link">
      <div class="session-card">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1 min-w-0">
            ${headlineLeft}
            ${metaTop ? `<div class="text-[11px] c-text-3 mt-0.5 truncate">${e(metaTop)}</div>` : ''}
          </div>
          ${stateChips.length > 0 ? `<div class="flex flex-col gap-1 items-end shrink-0">${stateChips.join('')}</div>` : ''}
        </div>
        <div class="session-metrics-row mt-2">${metricsHtml}</div>
        ${tagsRow}
      </div>
    </a>
  `
}

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
      return
    }
    if (action === 'filter-tag') {
      const value = btn.dataset.value
      state.tag = state.tag === value ? null : value
      await loadAndRender(root)
      return
    }
    if (action === 'filter-location') {
      const value = btn.dataset.value
      state.locationId = state.locationId === value ? null : value
      await loadAndRender(root)
      return
    }
    if (action === 'clear-facets') {
      ev.preventDefault()
      state.tag = null
      state.locationId = null
      await loadAndRender(root)
      return
    }
  })

  root.addEventListener('change', async (ev) => {
    const el = ev.target.closest('[data-action]')
    if (!el) return
    if (el.dataset.action === 'toggle-calm') {
      state.calmOnly = el.checked
      await loadAndRender(root)
    } else if (el.dataset.action === 'toggle-excluded') {
      state.includeExcluded = el.checked
      await loadAndRender(root)
    }
  })
}

function formatNum(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  if (Math.abs(v) >= 100 || Math.abs(v - Math.round(v)) < 0.05) return Math.round(v).toString()
  if (Math.abs(v) >= 10) return v.toFixed(1).replace('.', ',')
  return v.toFixed(2).replace('.', ',')
}

function formatDelta(v) {
  if (v === null || v === undefined) return '—'
  return (v >= 0 ? '+' : '') + Math.round(v)
}

export const LIST_STYLES = `
  ${ATOMS_STYLES}

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

  .list-toggles {
    display: flex; flex-wrap: wrap; gap: 14px;
    padding: 8px 12px;
    background: rgba(255,255,255,.45);
    border: 1px solid rgba(255,255,255,.5);
    border-radius: 14px;
  }
  .list-toggle {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--ink);
    cursor: pointer;
  }
  .list-toggle input[type="checkbox"] {
    appearance: none;
    width: 30px; height: 18px; border-radius: 999px;
    background: rgba(50, 58, 85, 0.18);
    position: relative; cursor: pointer; transition: background 0.15s;
    margin: 0;
  }
  .list-toggle input[type="checkbox"]::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 14px; height: 14px; border-radius: 999px;
    background: white; transition: left 0.15s;
  }
  .list-toggle input[type="checkbox"]:checked {
    background: var(--sage-deep);
  }
  .list-toggle input[type="checkbox"]:checked::after { left: 14px; }

  .filters-details {
    background: rgba(255,255,255,.45);
    border: 1px solid rgba(255,255,255,.5);
    border-radius: 14px;
    padding: 0;
    overflow: hidden;
  }
  .filters-summary {
    list-style: none;
    cursor: pointer;
    padding: 10px 14px;
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .filters-summary::-webkit-details-marker { display: none; }
  .filters-clear {
    font-size: 11px;
    color: var(--terra-deep);
    background: transparent;
    border: 0;
    cursor: pointer;
    padding: 2px 6px;
  }
  .filters-body {
    padding: 0 14px 12px;
  }
  .ctx-pillrow {
    display: flex; flex-wrap: wrap; gap: 6px;
  }
  .ctx-pill {
    font-size: 11px;
    padding: 4px 10px;
    border-radius: 999px;
    color: var(--text);
    background: rgba(255,255,255,.55);
    border: 1px solid rgba(255,255,255,.55);
    cursor: pointer;
  }
  .ctx-pill:hover { background: rgba(255,255,255,.75); }
  .ctx-pill.active {
    background: var(--ink-2);
    color: white;
    border-color: var(--ink-2);
  }

  /* Session card. */
  .session-list {
    display: flex; flex-direction: column; gap: 10px;
    padding-bottom: 24px;
  }
  .session-card-link {
    text-decoration: none; color: inherit;
    display: block;
  }
  .session-card {
    padding: 12px 14px;
    border-radius: 16px;
    background: rgba(255,255,255,.55);
    border: 1px solid rgba(255,255,255,.6);
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-backdrop-filter: blur(22px) saturate(140%);
    transition: background 0.15s;
  }
  .session-card:hover {
    background: rgba(255,255,255,.75);
  }
  .session-metrics-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .session-metric {
    display: flex; flex-direction: column; gap: 1px;
    font-size: 14px;
  }
  .session-metric-label {
    font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.12em;
    color: var(--text-3);
  }
`
