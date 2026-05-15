/* Edge Function: toggle-session-exclusion
 *
 * PWA button on the session screen: include / exclude this session from
 * baseline + trends.
 *
 * Rules from the brief (раздел 10):
 *   exclude=true:
 *     - excluded_from_stats = true
 *     - excluded_reason = 'manual'   (но если уже 'preview' — оставляем 'preview')
 *     - excluded_at = now()
 *   exclude=false:
 *     - excluded_from_stats = false
 *     - excluded_reason = null
 *     - excluded_at = null
 *     - session_kind = 'regular'     (если был 'preview', превращаем в обычную)
 *
 * Triggers recompute-meditation-baseline because baseline membership changes.
 *
 * Auth: user JWT (verify_jwt: true). RLS limits visibility/UPDATE to own sessions.
 * Deploy: supabase functions deploy toggle-session-exclusion
 *
 * Response: minimal { ok, session_id, excluded_from_stats, ... } — frontend
 * then re-fetches get-session-report for the fully refreshed view. */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

type ToggleRequest = {
  sessionId: string
  exclude: boolean
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) return json({ error: 'server_misconfigured' }, 500)

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthorized' }, 401)
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  })

  let body: ToggleRequest
  try { body = await req.json() } catch { return json({ error: 'invalid_json' }, 400) }
  if (!body.sessionId || typeof body.exclude !== 'boolean') {
    return json({ error: 'missing_field', message: 'sessionId and exclude required' }, 400)
  }

  /* Fetch current state — need session_kind/excluded_reason to decide if it was 'preview'. */
  const { data: current, error: fErr } = await supabase
    .from('meditation_sessions')
    .select('user_id, session_kind, excluded_reason')
    .eq('id', body.sessionId)
    .maybeSingle()
  if (fErr) return json({ error: 'db_error', message: fErr.message }, 500)
  if (!current) return json({ error: 'not_found' }, 404)

  /* Decide new state. */
  const wasPreview = current.excluded_reason === 'preview'
  const patch = body.exclude
    ? {
        excluded_from_stats: true,
        // Keep 'preview' label if it was already a preview-typed exclusion.
        excluded_reason: wasPreview ? 'preview' : 'manual',
        excluded_at: new Date().toISOString(),
      }
    : {
        excluded_from_stats: false,
        excluded_reason: null,
        excluded_at: null,
        // Re-including a preview session promotes it to regular.
        session_kind: 'regular',
      }

  const { error: uErr } = await supabase
    .from('meditation_sessions')
    .update(patch)
    .eq('id', body.sessionId)
  if (uErr) return json({ error: 'db_update_failed', message: uErr.message }, 500)

  /* Baseline membership changed → recompute. Non-fatal: lazy recompute in
   * get-session-report will catch up if this call fails. */
  try {
    await triggerRecompute(current.user_id as string)
  } catch (e) {
    console.error('recompute trigger failed (non-fatal):', e)
  }

  return json({
    ok: true,
    session_id: body.sessionId,
    excluded_from_stats: patch.excluded_from_stats,
    excluded_reason: patch.excluded_reason,
  })
})

async function triggerRecompute(userId: string): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing for recompute trigger')
  const resp = await fetch(`${url}/functions/v1/recompute-meditation-baseline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ user_id: userId }),
  })
  if (!resp.ok) throw new Error(`recompute returned ${resp.status}: ${await resp.text()}`)
}
