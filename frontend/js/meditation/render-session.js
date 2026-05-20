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
import { toggleSessionExclusion, submitSessionContext, loadUserLocations } from './api.js'

const VARIANT_KEY = 'panditji_main_chart_variant'
const VARIANT_DEFAULT = 'zones'
const VARIANT_VALID = new Set(['zones', 'bars', 'stream'])

/* Старое значение 'lines' молча мигрируем в 'zones' — вкладки «Линии» больше нет
 * (см. ТЗ §130), а оставлять её в localStorage у тех, кто открывал отчёт
 * раньше, бессмысленно. Это тот случай, когда стандартный fallback на дефолт
 * сделал бы скачок в «Столбики» — нам надо в «Светофор». */
function readVariant() {
  const v = localStorage.getItem(VARIANT_KEY)
  return VARIANT_VALID.has(v) ? v : VARIANT_DEFAULT
}

export function renderSession(root, report) {
  /* Session uploaded but circles not confirmed → show the fill-in form
   * instead of the regular report. After successful submit we reload, and
   * the regular branch below renders the now-completed report. */
  if (report.circles === null) {
    renderContextForm(root, report)
    return
  }

  const variant = readVariant()
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

/* ── context form (session without confirmed circles) ─────────────────── */

async function renderContextForm(root, report) {
  root.innerHTML = `
    ${PageHead({
      title: 'Дозаполнить',
      meta: `${report.date.split(',')[0]} · ${report.time.start}`,
      backHref: '/morning.html',
    })}
    <section class="mb-3">
      <h2 class="font-serif-m c-ink text-[22px] leading-tight">${e(report.date)}</h2>
      <div class="text-[12px] c-text-2 mt-1 num">
        ${e(report.time.start)}–${e(report.time.end)} · ${e(report.durationMin.toFixed(1).replace('.', ','))} мин · сигнал ${Math.round(report.signal.overall)}%
      </div>
      <div class="text-[12px] c-text-3 mt-2 leading-relaxed">
        Сессия загружена через бота, но не до конца оформлена. Ответь на пять вопросов — и откроется полный отчёт.
      </div>
    </section>

    <div id="ctx-form-body">
      <div class="text-[13px] c-text-3 py-6 text-center">Подгружаю места…</div>
    </div>
  `

  /* Load locations, then build the form body. */
  let locations = []
  try { locations = await loadUserLocations() } catch (err) { console.error('locations load failed:', err) }

  const formBody = root.querySelector('#ctx-form-body')
  formBody.innerHTML = formMarkup(locations)
  bindFormActions(root, report.id)
}

function formMarkup(locations) {
  const locButtons = locations.map(l =>
    `<button type="button" class="ctx-pill" data-field="location_id" data-value="${e(l.id)}">${e(l.name)}</button>`,
  ).join('')

  return `
    ${Card({ extraClass: 'mb-3', children: `
      ${SectionTitle({ children: '1. Что это?' })}
      <div class="ctx-pillrow mt-2">
        <button type="button" class="ctx-pill" data-field="kind" data-value="regular">Обычная джапа</button>
        <button type="button" class="ctx-pill" data-field="kind" data-value="preview">Только посмотреть</button>
      </div>
      <div class="text-[11px] c-text-3 mt-2 italic">«Только посмотреть» — сессия будет проанализирована, но не повлияет на статистику и средние.</div>
    ` })}

    ${Card({ extraClass: 'mb-3', children: `
      ${SectionTitle({ children: '2. Сколько кругов было?' })}
      <div class="ctx-pillrow mt-2">
        <button type="button" class="ctx-pill" data-field="circles" data-value="8">8</button>
        <button type="button" class="ctx-pill" data-field="circles" data-value="12">12</button>
        <button type="button" class="ctx-pill" data-field="circles" data-value="16">16</button>
        <button type="button" class="ctx-pill" data-field="circles" data-value="24">24</button>
      </div>
      <div class="ctx-row mt-2">
        <label class="text-[11px] c-text-3" for="ctx-circles-other">или впиши число:</label>
        <input id="ctx-circles-other" data-field="circles_text" type="number" min="1" max="200" inputmode="numeric"
               class="ctx-input num" placeholder="—">
      </div>
    ` })}

    ${Card({ extraClass: 'mb-3', children: `
      ${SectionTitle({ children: '3. Где сидел?' })}
      <div class="ctx-pillrow mt-2">
        ${locButtons || '<span class="text-[11px] c-text-3">Нет сохранённых мест — впиши новое:</span>'}
        <button type="button" class="ctx-pill" data-field="location_id" data-value="__custom__">другое</button>
      </div>
      <input data-field="location_name" type="text" maxlength="60" class="ctx-input mt-2" placeholder="Название места"
             style="display: none;">
    ` })}

    ${Card({ extraClass: 'mb-3', children: `
      ${SectionTitle({ children: '4. Отвлекали?' })}
      <div class="ctx-pillrow mt-2">
        <button type="button" class="ctx-pill" data-field="distracted" data-value="никто">Никто</button>
        <button type="button" class="ctx-pill" data-field="distracted" data-value="немного">Немного</button>
        <button type="button" class="ctx-pill" data-field="distracted" data-value="сильно">Сильно</button>
      </div>
    ` })}

    ${Card({ extraClass: 'mb-3', children: `
      ${SectionTitle({ children: '5. Как сам ощутил?' })}
      <div class="ctx-pillrow mt-2">
        ${[1, 2, 3, 4, 5].map(n =>
          `<button type="button" class="ctx-pill" data-field="self_rating" data-value="${n}">${n}</button>`,
        ).join('')}
      </div>
      <div class="text-[11px] c-text-3 mt-2 italic">1 = очень плохо, 5 = очень хорошо. Это твоё ощущение, отдельно от данных.</div>
    ` })}

    ${Card({ extraClass: 'mb-3', children: `
      ${SectionTitle({ children: 'Заметка (необязательно)' })}
      <textarea data-field="user_note" rows="2" maxlength="500" class="ctx-input mt-2"
                placeholder="Что-нибудь о сегодняшней практике?"></textarea>
    ` })}

    <div class="ctx-submit-row mb-6">
      <button type="button" id="ctx-submit" class="ctx-submit-btn" disabled>Сохранить и рассчитать</button>
      <div id="ctx-error" class="ctx-error" style="display: none;"></div>
    </div>
  `
}

function bindFormActions(root, sessionId) {
  if (root._ctxDelegated) return
  root._ctxDelegated = true

  const state = {
    kind: null, circles: null, location_id: null, location_name: null,
    distracted: null, self_rating: null, user_note: '',
  }

  const validate = () => {
    const haveLocation = (state.location_id && state.location_id !== '__custom__')
      || (state.location_id === '__custom__' && state.location_name && state.location_name.trim())
    return state.kind && state.circles && haveLocation && state.distracted && state.self_rating
  }

  const updateSubmit = () => {
    const btn = root.querySelector('#ctx-submit')
    if (btn) btn.disabled = !validate()
  }

  /* Pill clicks. */
  root.addEventListener('click', async (ev) => {
    const pill = ev.target.closest('.ctx-pill')
    if (pill) {
      const field = pill.dataset.field
      const value = pill.dataset.value
      state[field] = field === 'circles' ? parseInt(value, 10)
                   : field === 'self_rating' ? parseInt(value, 10)
                   : value

      /* Toggle active state inside the same pillrow. */
      pill.parentElement.querySelectorAll('.ctx-pill').forEach(p => {
        const isActive = p.dataset.field === field && p.dataset.value === value
        p.classList.toggle('active', isActive)
      })

      /* Show / hide the custom location input. */
      if (field === 'location_id') {
        const input = root.querySelector('input[data-field="location_name"]')
        if (input) input.style.display = value === '__custom__' ? 'block' : 'none'
        if (value !== '__custom__') state.location_name = null
      }

      /* Clear the "other circles" input when a preset is picked. */
      if (field === 'circles') {
        const other = root.querySelector('#ctx-circles-other')
        if (other) other.value = ''
      }

      updateSubmit()
      return
    }

    if (ev.target.id === 'ctx-submit') {
      await submit()
    }
  })

  /* Text inputs. */
  root.addEventListener('input', (ev) => {
    const el = ev.target
    if (el.dataset.field === 'circles_text') {
      const n = parseInt(el.value, 10)
      if (Number.isFinite(n) && n >= 1 && n <= 200) {
        state.circles = n
        /* De-select preset pills. */
        root.querySelectorAll('.ctx-pill[data-field="circles"]').forEach(p => p.classList.remove('active'))
      } else {
        state.circles = null
      }
      updateSubmit()
      return
    }
    if (el.dataset.field === 'location_name') {
      state.location_name = el.value
      updateSubmit()
      return
    }
    if (el.dataset.field === 'user_note') {
      state.user_note = el.value
      return
    }
  })

  async function submit() {
    if (!validate()) return
    const btn = root.querySelector('#ctx-submit')
    const errBox = root.querySelector('#ctx-error')
    btn.disabled = true
    btn.textContent = 'Считаю…'
    errBox.style.display = 'none'

    const payload = {
      session_id: sessionId,
      kind: state.kind,
      circles: state.circles,
      distracted: state.distracted,
      self_rating: state.self_rating,
      user_note: state.user_note?.trim() || null,
    }
    if (state.location_id && state.location_id !== '__custom__') {
      payload.location_id = state.location_id
    } else {
      payload.location_name = state.location_name.trim()
    }

    try {
      await submitSessionContext(payload)
      location.reload()
    } catch (err) {
      console.error('submit failed:', err)
      btn.disabled = false
      btn.textContent = 'Сохранить и рассчитать'
      errBox.style.display = 'block'
      errBox.textContent = 'Не удалось сохранить: ' + (err?.message ?? 'ошибка')
    }
  }
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
    { key: 'zones',  label: 'светофор' },
    { key: 'bars',   label: 'столбики' },
    { key: 'stream', label: 'поток' },
  ]
  const switcher = `
    <div class="chart-form-switch" role="tablist">
      ${variants.map(v =>
        `<button type="button" data-action="set-variant" data-variant="${v.key}"
                 class="form-switch-btn ${v.key === variant ? 'active' : ''}">${e(v.label)}</button>`,
      ).join('')}
    </div>`

  return Card({
    children: `
      <div class="flex items-center justify-between gap-2">
        ${SectionTitle({ children: 'Динамика по кругам' })}
        ${switcher}
      </div>
      <div class="mt-2" id="main-chart-legend">${legendFor(variant)}</div>
      <div id="main-chart" class="mt-2">${chartFor(report, variant)}</div>
      <div id="zones-overall" class="mt-3"${(variant === 'zones' && report.zonesOverall !== null) ? '' : ' hidden'}>${zonesOverallBlock(report)}</div>
      ${report.caption?.main ? `<div class="mt-2">${ClaudeBlock({ eyebrow: 'наблюдение', body: report.caption.main })}</div>` : ''}
    `,
    extraClass: 'mb-3',
  })
}

/* «Светофор» при zonesOverall === null показывает текстовый fallback и
 * не зовёт SVG-рендер (иначе нарисовались бы пустые рамки 0 кругов).
 * Сообщение по ТЗ §150-154 — без эмодзи, в стиле «Подтверди число кругов…»
 * из этого же файла. */
function chartFor(report, variant) {
  if (variant === 'zones' && report.zonesOverall === null) {
    return `<div class="zones-empty-msg">
      Эта сессия была записана без зон устойчивости. Светофор доступен только для записей из настольного монитора.
    </div>`
  }
  return renderMainChart(report.perCircle, variant)
}

/* Лёгкая полоска зон под графиком — общий итог по сессии. Скрыта на не-zones
 * вкладках. При zonesOverall === null прячется молча: текст уже показан в
 * самом графике, дублировать его двумя сообщениями некрасиво (ТЗ §163). */
function zonesOverallBlock(report) {
  const o = report.zonesOverall
  if (!o) return ''
  const g = o.green, y = o.yellow, r = o.red
  return `
    <div class="zones-overall-bar" role="img"
         aria-label="Общий баланс зон по сессии: зелёная ${fmtPct(g)}, жёлтая ${fmtPct(y)}, красная ${fmtPct(r)}.">
      <div class="seg-green"  style="width: ${g}%"></div>
      <div class="seg-yellow" style="width: ${y}%"></div>
      <div class="seg-red"    style="width: ${r}%"></div>
    </div>
    <div class="zones-overall-labels num">
      <span>зелёная ${fmtPct(g)}</span>
      <span class="sep">·</span>
      <span>жёлтая ${fmtPct(y)}</span>
      <span class="sep">·</span>
      <span>красная ${fmtPct(r)}</span>
    </div>
  `
}

function fmtPct(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return v.toFixed(1).replace('.', ',') + '%'
}

/* Легенда зависит от вкладки. У «Светофора» она про зоны, а не про A/Th/B. */
function legendFor(variant) {
  if (variant === 'zones') {
    return ChartLegend({ items: [
      { label: 'зелёная',   color: '#5fae7d' },
      { label: 'жёлтая',    color: '#c8b06a' },
      { label: 'красная',   color: '#cc6f52' },
    ]})
  }
  return ChartLegend({ items: [
    { label: 'Alpha', color: CHART_COLORS.alpha },
    { label: 'Theta', color: CHART_COLORS.theta },
    { label: 'Beta',  color: CHART_COLORS.beta, faded: true },
  ]})
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
    <div class="space-y-2 mb-3">
      <a href="/meditation/trends.html" class="block stats-cta">
        <span class="text-[13px] c-ink font-semibold">Статистика</span>
        <span class="text-[11px] c-text-3">тренды, корреляции →</span>
      </a>
      <a href="/meditation/" class="block stats-cta">
        <span class="text-[13px] c-ink font-semibold">Все сессии</span>
        <span class="text-[11px] c-text-3">список с фильтрами →</span>
      </a>
    </div>`
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
      if (container) container.innerHTML = chartFor(report, variant)
      const legend = root.querySelector('#main-chart-legend')
      if (legend) legend.innerHTML = legendFor(variant)
      const overall = root.querySelector('#zones-overall')
      if (overall) {
        overall.hidden = variant !== 'zones' || report.zonesOverall === null
        overall.innerHTML = zonesOverallBlock(report)
      }
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

  /* «Светофор»: общий итог по сессии. Полоска под графиком — крупная,
   * чтобы баланс зон считывался с одного взгляда (ТЗ §156-160). */
  .zones-overall-bar {
    display: flex;
    height: 14px;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.55);
    background: rgba(255,255,255,.45);
  }
  .zones-overall-bar .seg-green  { background: #5fae7d; }
  .zones-overall-bar .seg-yellow { background: #c8b06a; }
  .zones-overall-bar .seg-red    { background: #cc6f52; }
  .zones-overall-labels {
    margin-top: 6px;
    font-size: 11px;
    color: var(--text-2);
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: baseline;
  }
  .zones-overall-labels .sep { color: var(--text-3); }
  .zones-empty-msg {
    font-size: 13px;
    color: var(--text-2);
    line-height: 1.5;
    padding: 12px 4px;
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

  /* Context-form (when session has no confirmed circles). */
  .ctx-pillrow {
    display: flex; flex-wrap: wrap; gap: 6px;
  }
  .ctx-pill {
    font-size: 12px;
    padding: 6px 12px;
    border-radius: 999px;
    color: var(--text);
    background: rgba(255,255,255,.55);
    border: 1px solid rgba(255,255,255,.55);
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  .ctx-pill:hover { background: rgba(255,255,255,.75); }
  .ctx-pill.active {
    background: var(--ink-2);
    color: white;
    border-color: var(--ink-2);
  }
  .ctx-row {
    display: flex; align-items: center; gap: 8px;
  }
  .ctx-input {
    width: 100%;
    font-size: 13px;
    padding: 8px 12px;
    border-radius: 12px;
    color: var(--text);
    background: rgba(255,255,255,.55);
    border: 1px solid rgba(255,255,255,.55);
    outline: none;
    font-family: inherit;
  }
  .ctx-input:focus { background: rgba(255,255,255,.85); border-color: rgba(50,58,85,.25); }
  .ctx-row .ctx-input {
    flex: 1;
    max-width: 100px;
  }
  textarea.ctx-input { resize: vertical; }
  .ctx-submit-row {
    display: flex; flex-direction: column; gap: 8px;
  }
  .ctx-submit-btn {
    width: 100%;
    font-size: 14px;
    padding: 12px 16px;
    border-radius: 14px;
    background: var(--ink-2);
    color: white;
    border: 0;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .ctx-submit-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .ctx-error {
    font-size: 12px;
    color: var(--terra-deep);
    padding: 8px 12px;
    background: oklch(0.95 0.025 35 / 0.55);
    border: 1px solid oklch(0.85 0.07 35 / 0.50);
    border-radius: 12px;
  }
`
