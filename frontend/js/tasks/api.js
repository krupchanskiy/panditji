/* Supabase CRUD for tasks. Mutations go through the offline queue (offline.js),
 * which knows when to flush. List-load + realtime subscription stay here. */

import { db } from '../db.js'

const TASK_COLUMNS = 'id, text, notes, source, status, due_date, due_time, snooze_count, telegram_message_id, completed_at, created_at, updated_at'

/* Load: open tasks (any date) + today's completions. We never need older done tasks. */
export async function loadTasks(userId, today) {
  const [{ data: openRows, error: openErr }, { data: doneRows, error: doneErr }] = await Promise.all([
    db.from('tasks').select(TASK_COLUMNS)
      .eq('user_id', userId)
      .eq('status', 'open')
      .order('due_date', { ascending: true }),
    db.from('tasks').select(TASK_COLUMNS)
      .eq('user_id', userId)
      .eq('status', 'done')
      .gte('completed_at', `${today}T00:00:00`)
      .order('completed_at', { ascending: false }),
  ])
  if (openErr) throw openErr
  if (doneErr) throw doneErr
  return [...(openRows ?? []), ...(doneRows ?? [])]
}

/* Single task by id (used after conflict-resolution to pull latest server state). */
export async function readTask(id) {
  const { data, error } = await db.from('tasks').select(TASK_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

/* Wire-level INSERT. Caller supplies a client-generated UUID so the task can show
 * up locally before the network round-trip. */
export async function insertTask(userId, task) {
  const { data, error } = await db.from('tasks').insert({
    id: task.id,
    user_id: userId,
    text: task.text,
    notes: task.notes ?? null,
    source: task.source,
    status: task.status ?? 'open',
    due_date: task.due_date,
    due_time: task.due_time ?? null,
    snooze_count: task.snooze_count ?? 0,
  }).select(TASK_COLUMNS).single()
  if (error) throw error
  return data
}

export async function updateTask(id, patch) {
  const { data, error } = await db.from('tasks').update(patch).eq('id', id).select(TASK_COLUMNS).single()
  if (error) throw error
  return data
}

export async function deleteTask(id) {
  const { error } = await db.from('tasks').delete().eq('id', id)
  if (error) throw error
}

/* Realtime: returns the channel so caller can unsubscribe on teardown. */
export function subscribeTasks(userId, handlers) {
  return db.channel('tasks-changes')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'tasks',
      filter: `user_id=eq.${userId}`,
    }, (payload) => {
      if (payload.eventType === 'INSERT' && handlers.onInsert) handlers.onInsert(payload.new)
      else if (payload.eventType === 'UPDATE' && handlers.onUpdate) handlers.onUpdate(payload.new)
      else if (payload.eventType === 'DELETE' && handlers.onDelete) handlers.onDelete(payload.old)
    })
    .subscribe()
}
