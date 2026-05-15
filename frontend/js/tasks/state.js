/* Tiny pub-sub store. State shape: { today, tz, tasks: Map<id, Task>, expandedDone, online }. */

const listeners = new Set()

const state = {
  today: null,
  tz: null,
  tasks: new Map(),
  expandedDone: localStorage.getItem('tasks.expandedDone') === '1',
  online: navigator.onLine,
}

export function getState() { return state }

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  for (const fn of listeners) fn(state)
}

/* ── Init ─────────────────────────────────────────────────────────────── */

export function initState({ today, tz, tasks }) {
  state.today = today
  state.tz = tz
  state.tasks = new Map(tasks.map((t) => [t.id, t]))
  emit()
}

export function setToday(today) {
  if (state.today === today) return
  state.today = today
  emit()
}

export function setOnline(online) {
  if (state.online === online) return
  state.online = online
  emit()
}

export function toggleDoneExpanded() {
  state.expandedDone = !state.expandedDone
  localStorage.setItem('tasks.expandedDone', state.expandedDone ? '1' : '0')
  emit()
}

/* ── Task mutations (purely local; persistence is the caller's job) ──── */

export function upsertTask(task) {
  state.tasks.set(task.id, task)
  emit()
}

export function patchTask(id, patch) {
  const cur = state.tasks.get(id)
  if (!cur) return
  state.tasks.set(id, { ...cur, ...patch })
  emit()
}

export function removeTask(id) {
  state.tasks.delete(id)
  emit()
}

/* ── Grouping ─────────────────────────────────────────────────────────── */

export function selectGroups() {
  const today = state.today
  const tails = []
  const todays = []
  const doneToday = []

  for (const t of state.tasks.values()) {
    if (t.status === 'open' && t.due_date < today) tails.push(t)
    else if (t.status === 'open' && t.due_date === today) todays.push(t)
    else if (t.status === 'done' && t.completed_at) {
      const completedLocal = isoDateInTz(t.completed_at, state.tz)
      if (completedLocal === today) doneToday.push(t)
    }
  }

  /* Stable order: tails by due_date asc then created_at; today by due_time then created_at; done by completed_at desc. */
  tails.sort((a, b) => cmp(a.due_date, b.due_date) || cmp(a.created_at, b.created_at))
  todays.sort((a, b) => {
    const ta = a.due_time ?? '99:99'
    const tb = b.due_time ?? '99:99'
    return cmp(ta, tb) || cmp(a.created_at, b.created_at)
  })
  doneToday.sort((a, b) => cmp(b.completed_at, a.completed_at))

  return { tails, todays, doneToday }
}

function cmp(a, b) {
  if (a === b) return 0
  return a < b ? -1 : 1
}

function isoDateInTz(timestamp, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(timestamp))
}
