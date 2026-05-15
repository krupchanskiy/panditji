/* Bottom-sheets. Two flavours share one #sheet container:
 *
 *   snooze  — pick a new due_date (presets + month calendar)
 *   detail  — inline-edit text / notes; delete; close
 *
 * Sheet stays a single DOM node — only innerHTML changes between opens.
 * Saves go through callbacks supplied by main.js, never directly to api.js. */

import { getState } from './state.js'
import {
  addDays, dowOf, dayDiff, formatCalMonth, nextWeekday, parseISODate, formatCreatedAt,
} from './dates.js'
import { ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT, ICON_TG } from './icons.js'
import { escapeHtml } from './render.js'

const DOW_RU = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']

let callbacks = null
let detailCtx = null   // { id, snapshot } for the currently open detail sheet
let calCtx = null      // { taskId, viewYear, viewMonth } for snooze sheet

export function installSheets(cbs) {
  callbacks = cbs

  const scrim = document.getElementById('scrim')
  scrim.addEventListener('click', closeSheet)

  /* Sheet's own delegated clicks. */
  const sheet = document.getElementById('sheet')
  sheet.addEventListener('click', onSheetClick)
}

function onSheetClick(e) {
  const t = e.target.closest('[data-action]')
  if (!t) return
  const a = t.dataset.action
  if (a === 'sheet-close') closeSheet()
  else if (a === 'snooze-preset' || a === 'cal-pick') applySnoozeIso(t.dataset.iso)
  else if (a === 'cal-prev') shiftCal(-1)
  else if (a === 'cal-next') shiftCal(+1)
  else if (a === 'detail-save') saveDetail()
  else if (a === 'detail-delete') deleteDetail()
}

/* ── Public open/close ───────────────────────────────────────────────── */

export function openSnooze(taskId) {
  const today = getState().today
  const { y, m } = parseISODate(today)
  calCtx = { taskId, viewYear: y, viewMonth: m }
  renderSnooze()
  show()
}

export function openDetail(taskId) {
  const task = getState().tasks.get(taskId)
  if (!task) return
  detailCtx = { id: taskId, snapshot: { text: task.text, notes: task.notes ?? '' } }
  renderDetail(task)
  show()
}

export function closeSheet() {
  const scrim = document.getElementById('scrim')
  const sheet = document.getElementById('sheet')
  scrim.classList.remove('show')
  sheet.classList.remove('show')
  detailCtx = null
  calCtx = null
}

function show() {
  const scrim = document.getElementById('scrim')
  const sheet = document.getElementById('sheet')
  scrim.classList.add('show')
  sheet.classList.add('show')
}

/* ── Snooze sheet ────────────────────────────────────────────────────── */

function renderSnooze() {
  const today = getState().today
  const tomorrow = addDays(today, 1)
  const dayAfter = addDays(today, 2)
  const monday = nextWeekday(today, 1)
  const weekAhead = addDays(today, 7)

  const sheet = document.getElementById('sheet')
  sheet.innerHTML = `
    <div class="grip"></div>
    <div class="sheet-title">Перенести на</div>
    <div class="presets">
      ${presetCell('Завтра', tomorrow, true)}
      ${presetCell('Послезавтра', dayAfter, false)}
      ${presetCell('В понедельник', monday, false)}
      ${presetCell('Через неделю', weekAhead, false)}
    </div>
    ${renderCal()}
  `
}

function presetCell(label, iso, featured) {
  const { m, d } = parseISODate(iso)
  const monthShort = ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'][m - 1]
  const dowShort = DOW_RU[(dowOf(iso) + 6) % 7]  // dowOf gives Sun=0; rotate for ru pn=0
  return `
    <button type="button" class="preset ${featured ? 'featured' : ''}" data-action="snooze-preset" data-iso="${iso}">
      <span class="label">${label}</span>
      <span class="day num">${d} ${monthShort} · ${dowShort}</span>
    </button>
  `
}

function renderCal() {
  const { viewYear: y, viewMonth: m } = calCtx
  const monthLabel = formatCalMonth(y, m)

  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  /* Convert Sun=0…Sat=6 to Mon=0…Sun=6 (we render Mon first). */
  const leading = (firstDow + 6) % 7
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const daysInPrev = new Date(Date.UTC(y, m - 1, 0)).getUTCDate()
  const today = getState().today

  const cells = []

  /* Leading muted days from the previous month. */
  for (let i = leading - 1; i >= 0; i--) {
    const day = daysInPrev - i
    cells.push(`<div class="day muted">${day}</div>`)
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const cls = ['day']
    if (iso === today) cls.push('today')
    cells.push(`<div class="${cls.join(' ')}" data-action="cal-pick" data-iso="${iso}">${day}</div>`)
  }
  /* Trailing muted days to fill the last row to 7. */
  const filled = cells.length
  const trail = (7 - (filled % 7)) % 7
  for (let i = 1; i <= trail; i++) cells.push(`<div class="day muted">${i}</div>`)

  return `
    <div class="cal">
      <div class="cal-month">
        <div class="name">${monthLabel}</div>
        <div class="nav">
          <button type="button" data-action="cal-prev" aria-label="прошлый">${ICON_CHEVRON_LEFT}</button>
          <button type="button" data-action="cal-next" aria-label="следующий">${ICON_CHEVRON_RIGHT}</button>
        </div>
      </div>
      <div class="cal-grid">
        ${DOW_RU.map((d) => `<div class="dow">${d}</div>`).join('')}
        ${cells.join('')}
      </div>
    </div>
  `
}

function shiftCal(delta) {
  if (!calCtx) return
  let m = calCtx.viewMonth + delta
  let y = calCtx.viewYear
  while (m < 1) { m += 12; y -= 1 }
  while (m > 12) { m -= 12; y += 1 }
  calCtx.viewYear = y
  calCtx.viewMonth = m
  document.getElementById('sheet').querySelector('.cal').outerHTML = renderCal()
}

function applySnoozeIso(iso) {
  if (!calCtx || !iso) return
  callbacks?.onSnoozeApply?.(calCtx.taskId, iso)
  closeSheet()
}

/* ── Detail sheet ────────────────────────────────────────────────────── */

function renderDetail(task) {
  const today = getState().today
  const overdueDays = task.due_date < today ? Math.abs(dayDiff(task.due_date, today)) : 0

  const sheet = document.getElementById('sheet')
  sheet.classList.add('detail')
  sheet.innerHTML = `
    <div class="grip"></div>
    <textarea class="title-input" id="detail-title" rows="2">${escapeHtml(task.text)}</textarea>

    <div class="field-row">
      <div class="lbl">Источник</div>
      <div class="val">${renderSource(task.source)}</div>
    </div>

    <div class="field-row">
      <div class="lbl">Дата</div>
      <div class="val">
        ${renderDueValue(task, today, overdueDays)}
      </div>
    </div>

    <div class="field-row">
      <div class="lbl">Создано</div>
      <div class="val muted">${formatCreatedAt(task.created_at)}</div>
    </div>

    <div class="field-row">
      <div class="lbl">Переносов</div>
      <div class="val muted num">${task.snooze_count}</div>
    </div>

    <textarea class="notes" id="detail-notes" placeholder="Заметка — для себя">${escapeHtml(task.notes ?? '')}</textarea>

    <div class="actions">
      <button type="button" class="btn danger" data-action="detail-delete">Удалить</button>
      <button type="button" class="btn primary" data-action="detail-save">Готово</button>
    </div>
  `
}

function renderSource(source) {
  if (source === 'telegram') return `<span class="pill-src">${ICON_TG} Telegram</span>`
  return `<span class="pill-src web">Web</span>`
}

function renderDueValue(task, today, overdueDays) {
  const { y, m, d } = parseISODate(task.due_date)
  const monthName = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][m - 1]
  const absoluteSuffix = task.due_time ? ` · ${task.due_time}` : ''
  let main = `${d} ${monthName}${absoluteSuffix}`
  if (task.due_date < today) {
    main += `  <span style="color: var(--terra-deep); font-weight: 600;">просрочено · ${overdueDays}</span>`
  }
  return main
}

function saveDetail() {
  if (!detailCtx) return
  const titleEl = document.getElementById('detail-title')
  const notesEl = document.getElementById('detail-notes')
  const text = (titleEl?.value ?? '').trim()
  const notes = (notesEl?.value ?? '').trim()
  if (!text) {
    /* Don't allow blanking the title. Just close without saving. */
    closeSheet()
    return
  }
  const patch = {}
  if (text !== detailCtx.snapshot.text) patch.text = text
  if (notes !== (detailCtx.snapshot.notes ?? '')) patch.notes = notes || null
  if (Object.keys(patch).length > 0) {
    callbacks?.onDetailSave?.(detailCtx.id, patch)
  }
  closeSheet()
  document.getElementById('sheet').classList.remove('detail')
}

function deleteDetail() {
  if (!detailCtx) return
  const id = detailCtx.id
  callbacks?.onDetailDelete?.(id)
  closeSheet()
  document.getElementById('sheet').classList.remove('detail')
}
