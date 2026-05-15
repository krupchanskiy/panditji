/* Renders the tasks page. Plain DOM, no framework.
 * Sections are diffed at the row level — keep keyed nodes around so swipe-in-progress
 * doesn't get nuked when an unrelated task arrives via Realtime. */

import { getState, selectGroups, toggleDoneExpanded } from './state.js'
import { formatDue, formatTail, formatTime, pluralize } from './dates.js'
import {
  ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT, ICON_HOME, ICON_PLUS,
  ICON_CHECK, ICON_ARROW_RIGHT, ICON_SMILE_GLYPH, ICON_CHECK_GLYPH,
} from './icons.js'

const app = () => document.getElementById('app')

/* Top-level structure stays stable across renders; we only swap children of #app-sections. */
let scaffolded = false

export function renderPage(callbacks) {
  if (!scaffolded) {
    app().innerHTML = `
      <div class="page-head">
        <button class="back-btn" data-action="back" aria-label="назад">${ICON_CHEVRON_LEFT}</button>
        <div class="title">Задачи</div>
        <button class="home-btn" data-action="home" aria-label="на главную">${ICON_HOME}</button>
      </div>
      <div class="offline-pill" id="offline-pill" hidden>Без сети — изменения уйдут, когда подключение вернётся.</div>
      <form class="add-input" id="add-form" autocomplete="off">
        <span class="plus">${ICON_PLUS}</span>
        <input id="add-input" type="text" placeholder="Добавить задачу…" enterkeyhint="done" />
        <span class="kbd">⏎</span>
      </form>
      <div id="app-sections"></div>
    `
    wireScaffold(callbacks)
    scaffolded = true
  }

  const sections = document.getElementById('app-sections')
  const offlinePill = document.getElementById('offline-pill')
  const { online } = getState()
  offlinePill.hidden = online

  const { tails, todays, doneToday } = selectGroups()
  const totalOpen = tails.length + todays.length

  /* Empty states. */
  if (totalOpen === 0 && doneToday.length === 0) {
    sections.innerHTML = renderEmpty()
    return
  }
  if (totalOpen === 0 && doneToday.length > 0) {
    sections.innerHTML = `
      ${renderAllDone()}
      ${renderDoneHeader(doneToday.length)}
      ${renderState().expandedDone ? renderTaskList(doneToday) : ''}
    `
    return
  }

  sections.innerHTML = `
    ${tails.length ? renderTailsHead() + renderTaskList(tails) : ''}
    ${renderTodayHead(todays.length)}
    ${todays.length ? renderTaskList(todays) : renderTodayEmptyInline()}
    ${doneToday.length ? renderDoneHeader(doneToday.length) : ''}
    ${doneToday.length && renderState().expandedDone ? renderTaskList(doneToday) : ''}
  `
}

function renderState() { return getState() }

/* ── Empty / done states ─────────────────────────────────────────────── */

function renderEmpty() {
  return `
    <div class="empty-state">
      <div class="glyph">${ICON_SMILE_GLYPH}</div>
      <div class="line">На сегодня ничего не запланировано.</div>
      <div class="sub">Введите задачу сверху — Enter создаёт.</div>
    </div>
  `
}

function renderAllDone() {
  return `
    <div class="empty-state compact">
      <div class="glyph sage">${ICON_CHECK_GLYPH}</div>
      <div class="line">На сегодня всё.</div>
    </div>
  `
}

function renderTodayEmptyInline() {
  return ''
}

/* ── Section heads ───────────────────────────────────────────────────── */

function renderTailsHead() {
  return `
    <div class="sec-head">
      <div class="title terra">Хвосты</div>
      <div class="meta">остались с прошлого</div>
    </div>
  `
}

function renderTodayHead(count) {
  const label = count === 0 ? 'ничего' : `${count} ${pluralize(count, 'задача', 'задачи', 'задач')}`
  return `
    <div class="sec-head">
      <div class="title">Сегодня</div>
      <div class="meta num">${label}</div>
    </div>
  `
}

function renderDoneHeader(count) {
  const expanded = getState().expandedDone
  return `
    <div class="done-head ${expanded ? 'expanded' : ''}" data-action="toggle-done">
      <span class="chev">${ICON_CHEVRON_RIGHT}</span>
      <span class="title">Сделано</span>
      <span class="count num">${count}</span>
    </div>
  `
}

/* ── Task rows ───────────────────────────────────────────────────────── */

function renderTaskList(tasks) {
  return `<div class="task-list">${tasks.map(renderTaskRow).join('')}</div>`
}

function renderTaskRow(task) {
  const isTail = task.status === 'open' && task.due_date < getState().today
  const isDone = task.status === 'done'

  const modifierClasses = [isTail ? 'tail' : '', isDone ? 'done' : ''].filter(Boolean).join(' ')

  const whenLine = isTail
    ? `<div class="when">${escapeHtml(formatTail(getState().today, task.due_date))}</div>`
    : ''

  const time = formatTime(task.due_time)
  const timeLine = (!isTail && !isDone && time)
    ? `<div class="badge-time">в ${time}</div>`
    : ''

  const trailing = isDone ? '' : `
    <div class="arrow" data-action="snooze-open" data-id="${task.id}">${ICON_ARROW_RIGHT}</div>
  `

  const taskNode = `
    <div class="task ${modifierClasses}" data-id="${task.id}" data-status="${task.status}" data-tail="${isTail ? '1' : '0'}">
      <div class="check" data-action="toggle-check" data-id="${task.id}">${ICON_CHECK}</div>
      <div class="body" data-action="open-details" data-id="${task.id}">
        <div class="text">${escapeHtml(task.text)}</div>
        ${whenLine}
        ${timeLine}
      </div>
      ${trailing}
    </div>
  `

  if (isDone) return taskNode

  /* .swipe-wrap is a positioned container; the inner .task gets translated by JS,
   * sliding to reveal the sage (right swipe) or terra (left swipe) reveal beneath. */
  return `
    <div class="swipe-wrap" data-id="${task.id}">
      <div class="swipe-reveal right" hidden>${ICON_CHECK} <span>Выполнено</span></div>
      <div class="swipe-reveal left" hidden><span>На завтра</span> ${ICON_ARROW_RIGHT}</div>
      ${taskNode}
    </div>
  `
}

/* ── Scaffold wiring (one-time) ──────────────────────────────────────── */

function wireScaffold(cb) {
  const form = document.getElementById('add-form')
  const input = document.getElementById('add-input')
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text) return
    cb.onCreate(text)
    input.value = ''
    input.focus()
  })

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]')
    if (!t) return
    const a = t.dataset.action
    const id = t.dataset.id
    if (a === 'back' || a === 'home') {
      window.location.href = '/index.html'
    } else if (a === 'toggle-done') {
      toggleDoneExpanded()
    } else if (a === 'toggle-check') {
      cb.onToggleCheck(id)
    } else if (a === 'open-details') {
      cb.onOpenDetails(id)
    } else if (a === 'snooze-open') {
      cb.onOpenSnooze(id)
    }
  })
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

export function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
