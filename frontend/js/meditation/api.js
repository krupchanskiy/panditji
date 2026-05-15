/* Tiny wrapper around our Edge Functions.
 *
 * Supabase JS's functions.invoke() is POST-only; our read endpoints (get-session-report,
 * get-trends-report) are GET with query params. So we drive them via raw fetch with the
 * user's access token from the active session. POST endpoints could use invoke(), but
 * keeping one shape simplifies error handling. */

import { db, SUPABASE_URL, SUPABASE_KEY } from '../db.js'

async function callEdge(name, { method = 'GET', params, body } = {}) {
  const { data: { session } } = await db.auth.getSession()
  if (!session) throw new Error('not_authenticated')

  let url = `${SUPABASE_URL}/functions/v1/${name}`
  if (params) {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) sp.set(k, String(v))
    }
    if ([...sp].length > 0) url += '?' + sp.toString()
  }

  const headers = {
    Authorization: `Bearer ${session.access_token}`,
    apikey: SUPABASE_KEY,
  }
  if (body) headers['Content-Type'] = 'application/json'

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!resp.ok) {
    const text = await resp.text()
    let parsed
    try { parsed = JSON.parse(text) } catch { parsed = { message: text } }
    const err = new Error(parsed.message ?? parsed.error ?? `${name} ${resp.status}`)
    err.code = parsed.code
    err.status = resp.status
    throw err
  }
  return await resp.json()
}

export function getSessionReport(sessionId, calmOnly = true) {
  return callEdge('get-session-report', {
    params: { id: sessionId, calm_only: calmOnly },
  })
}

export function getTrendsReport(period = 30, calmOnly = true) {
  return callEdge('get-trends-report', {
    params: { period, calm_only: calmOnly },
  })
}

export function toggleSessionExclusion(sessionId, exclude) {
  return callEdge('toggle-session-exclusion', {
    method: 'POST',
    body: { sessionId, exclude },
  })
}
