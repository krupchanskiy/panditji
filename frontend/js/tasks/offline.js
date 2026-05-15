/* Offline mutation queue, stored in IndexedDB.
 *
 * Operations: insert | update | delete. Each carries a client_ts plus, for updates,
 * the base_updated_at the client thought it was patching.
 *
 * Conflict resolution at flush time:
 *   INSERT — UUIDs are client-generated and globally unique, so we just send it.
 *   UPDATE — read server row; if updated_at > base_updated_at, compare client_ts
 *            against server updated_at and let the later one win.
 *   DELETE — if server row already gone, succeed silently. */

import { insertTask, updateTask, deleteTask, readTask } from './api.js'

const DB_NAME = 'panditji-tasks'
const STORE = 'queue'
const DB_VERSION = 1

let dbPromise = null
let flushPromise = null

function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'queue_id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx(mode, fn) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const store = t.objectStore(STORE)
    const result = fn(store)
    t.oncomplete = () => resolve(result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

async function enqueue(op) {
  return tx('readwrite', (store) => { store.add(op) })
}

async function readAll() {
  return tx('readonly', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  })
}

async function removeQueueItem(queue_id) {
  return tx('readwrite', (store) => { store.delete(queue_id) })
}

/* ── Public API used by main.js ──────────────────────────────────────── */

export async function queueInsert(userId, task) {
  await enqueue({
    type: 'insert',
    user_id: userId,
    data: { ...task },
    client_ts: Date.now(),
  })
  scheduleFlush()
}

export async function queueUpdate(id, patch, baseUpdatedAt) {
  await enqueue({
    type: 'update',
    id,
    patch,
    base_updated_at: baseUpdatedAt,
    client_ts: Date.now(),
  })
  scheduleFlush()
}

export async function queueDelete(id) {
  await enqueue({
    type: 'delete',
    id,
    client_ts: Date.now(),
  })
  scheduleFlush()
}

function scheduleFlush() {
  if (!navigator.onLine) return
  /* Coalesce calls — one flush in flight at a time. */
  if (flushPromise) return
  flushPromise = flushNow().finally(() => { flushPromise = null })
}

export async function flushNow(handlers = {}) {
  const ops = (await readAll()).sort((a, b) => a.queue_id - b.queue_id)
  if (ops.length === 0) return

  for (const op of ops) {
    try {
      if (op.type === 'insert') {
        const server = await insertTask(op.user_id, op.data)
        handlers.onApplied?.(server)
      } else if (op.type === 'update') {
        const server = await readTask(op.id)
        if (!server) {
          /* Row gone (deleted elsewhere). Drop the patch. */
          handlers.onDropped?.(op.id)
        } else if (server.updated_at === op.base_updated_at) {
          const updated = await updateTask(op.id, op.patch)
          handlers.onApplied?.(updated)
        } else {
          /* Server moved on. Compare timestamps. */
          const serverMs = new Date(server.updated_at).getTime()
          if (op.client_ts > serverMs) {
            const updated = await updateTask(op.id, op.patch)
            handlers.onApplied?.(updated)
          } else {
            console.warn('task update dropped — server newer', { id: op.id, client_ts: op.client_ts, server_updated_at: server.updated_at })
            handlers.onConflict?.(server)
          }
        }
      } else if (op.type === 'delete') {
        await deleteTask(op.id)
        handlers.onApplied?.({ id: op.id, _deleted: true })
      }
      await removeQueueItem(op.queue_id)
    } catch (err) {
      /* Network error — bail; retry on next online event. */
      if (!navigator.onLine) return
      console.error('flush op failed', op, err)
      /* Drop the broken op so we don't loop forever on a malformed entry. */
      await removeQueueItem(op.queue_id)
    }
  }
}

/* Public so main.js can wire onload + online listeners. */
export function installOfflineSync(handlers = {}) {
  window.addEventListener('online', () => flushNow(handlers).catch((e) => console.error(e)))
  /* Initial drain on load. */
  flushNow(handlers).catch((e) => console.error(e))
}
