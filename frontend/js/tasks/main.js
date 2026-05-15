/* Bootstrap + glue layer for the tasks page.
 *
 * 1. Authenticate, load profile (for tz), load tasks.
 * 2. Hydrate state, render once.
 * 3. Wire callbacks: create / toggle / snooze / details / delete.
 * 4. Subscribe to Realtime (Telegram-bot inserts arrive here).
 * 5. Drain the offline queue if any ops are pending.
 *
 * Mutations follow the pattern:
 *   - apply locally (optimistic)
 *   - enqueue for server
 *   - if a 5-second undo toast applies, hold the commit until the timer fires. */

import { db, requireAuth } from '../db.js'
import * as State from './state.js'
import * as Api from './api.js'
import * as Offline from './offline.js'
import { renderPage } from './render.js'
import { installGestures } from './gestures.js'
import { installSheets, openSnooze, openDetail } from './sheets.js'
import { showUndoToast } from './toast.js'
import { localDate, addDays } from './dates.js'

let currentUserId = null
let currentTz = null

export async function initTasksPage() {
  const user = await requireAuth()
  if (!user) return
  currentUserId = user.id

  /* Profile → TZ (locations table is keyed by user_profile.current_location_id). */
  const tz = await fetchUserTz(user.id)
  currentTz = tz
  const today = localDate(tz)

  /* Load + bootstrap state. */
  const tasks = await Api.loadTasks(user.id, today)
  State.initState({ today, tz, tasks })

  /* Initial render + scaffold wiring. */
  renderPage(buildPageCallbacks())
  State.subscribe(() => renderPage(buildPageCallbacks()))

  /* Gestures: swipes on .task. */
  installGestures({
    onComplete: handleComplete,
    onSnooze: handleSnoozeTomorrow,
  })

  /* Sheets: snooze date picker + details. */
  installSheets({
    onSnoozeApply: handleSnoozeApply,
    onDetailSave: handleDetailSave,
    onDetailDelete: handleDelete,
  })

  /* Realtime updates — bot insertions, edits made on another device. */
  Api.subscribeTasks(user.id, {
    onInsert: (row) => State.upsertTask(row),
    onUpdate: (row) => State.upsertTask(row),
    onDelete: (row) => State.removeTask(row.id),
  })

  /* Online/offline state. */
  window.addEventListener('online',  () => State.setOnline(true))
  window.addEventListener('offline', () => State.setOnline(false))

  /* Roll the day over at local midnight without requiring a reload. */
  scheduleMidnightTick(tz)

  /* Drain queued operations, applying any server-returned rows. */
  Offline.installOfflineSync({
    onApplied: (row) => {
      if (row?._deleted) State.removeTask(row.id)
      else if (row) State.upsertTask(row)
    },
    onConflict: (server) => State.upsertTask(server),
    onDropped: (id) => State.removeTask(id),
  })
}

/* ── Profile lookup ──────────────────────────────────────────────────── */

async function fetchUserTz(userId) {
  const { data: profile, error } = await db
    .from('user_profile')
    .select('current_location_id')
    .eq('id', userId)
    .single()
  if (error) throw error
  if (profile.current_location_id) {
    const { data: loc } = await db
      .from('locations').select('timezone')
      .eq('id', profile.current_location_id).maybeSingle()
    if (loc?.timezone) return loc.timezone
  }
  return 'Europe/Moscow'
}

/* ── Callbacks fed into renderPage() ─────────────────────────────────── */

function buildPageCallbacks() {
  return {
    onCreate: handleCreate,
    onToggleCheck: handleToggleCheck,
    onOpenDetails: openDetail,
    onOpenSnooze: openSnooze,
  }
}

/* ── Mutations ───────────────────────────────────────────────────────── */

async function handleCreate(text) {
  const id = crypto.randomUUID()
  const nowIso = new Date().toISOString()
  const task = {
    id,
    text,
    notes: null,
    source: 'web',
    status: 'open',
    due_date: State.getState().today,
    due_time: null,
    snooze_count: 0,
    telegram_message_id: null,
    completed_at: null,
    created_at: nowIso,
    updated_at: nowIso,
  }
  State.upsertTask(task)
  await Offline.queueInsert(currentUserId, task)
}

function handleToggleCheck(id) {
  const task = State.getState().tasks.get(id)
  if (!task) return
  if (task.status === 'open') {
    handleComplete(id)
  } else {
    /* Un-complete with no toast — it's a deliberate tap on the filled circle. */
    const patch = { status: 'open', completed_at: null }
    const baseUpdatedAt = task.updated_at
    State.patchTask(id, { ...patch, updated_at: new Date().toISOString() })
    Offline.queueUpdate(id, patch, baseUpdatedAt)
  }
}

function handleComplete(id) {
  const task = State.getState().tasks.get(id)
  if (!task || task.status === 'done') return

  const baseUpdatedAt = task.updated_at
  const completedAt = new Date().toISOString()
  const patch = { status: 'done', completed_at: completedAt }

  State.patchTask(id, { ...patch, updated_at: completedAt })

  showUndoToast({
    kind: 'done',
    text: 'Выполнено',
    onCommit: () => Offline.queueUpdate(id, patch, baseUpdatedAt),
    onRevert: () => State.patchTask(id, { status: 'open', completed_at: null, updated_at: baseUpdatedAt }),
  })
}

function handleSnoozeTomorrow(id) {
  const task = State.getState().tasks.get(id)
  if (!task) return
  const newDate = addDays(State.getState().today, 1)
  const baseUpdatedAt = task.updated_at
  const patch = { due_date: newDate, snooze_count: (task.snooze_count ?? 0) + 1 }

  State.patchTask(id, { ...patch, updated_at: new Date().toISOString() })

  showUndoToast({
    kind: 'snooze',
    text: 'Перенесено на завтра',
    onCommit: () => Offline.queueUpdate(id, patch, baseUpdatedAt),
    onRevert: () => State.patchTask(id, {
      due_date: task.due_date,
      snooze_count: task.snooze_count ?? 0,
      updated_at: baseUpdatedAt,
    }),
  })
}

function handleSnoozeApply(id, iso) {
  const task = State.getState().tasks.get(id)
  if (!task) return
  const baseUpdatedAt = task.updated_at
  const patch = { due_date: iso, snooze_count: (task.snooze_count ?? 0) + 1 }
  State.patchTask(id, { ...patch, updated_at: new Date().toISOString() })
  Offline.queueUpdate(id, patch, baseUpdatedAt)
}

function handleDetailSave(id, patch) {
  const task = State.getState().tasks.get(id)
  if (!task) return
  const baseUpdatedAt = task.updated_at
  State.patchTask(id, { ...patch, updated_at: new Date().toISOString() })
  Offline.queueUpdate(id, patch, baseUpdatedAt)
}

function handleDelete(id) {
  State.removeTask(id)
  Offline.queueDelete(id)
}

/* ── Midnight rollover ───────────────────────────────────────────────── */

function scheduleMidnightTick(tz) {
  const tick = () => {
    const newToday = localDate(tz)
    if (newToday !== State.getState().today) State.setToday(newToday)
    setTimeout(tick, msUntilNextMinute())
  }
  setTimeout(tick, msUntilNextMinute())
}

function msUntilNextMinute() {
  const now = new Date()
  return (60 - now.getSeconds()) * 1000 - now.getMilliseconds()
}
