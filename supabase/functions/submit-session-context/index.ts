/* Edge Function: submit-session-context
 *
 * PWA-альтернатива Telegram-диалогу: принимает все 5 ответов о сессии разом,
 * апдейтит meditation_sessions, опционально создаёт новую locations-запись
 * (для "другое место"), вызывает compute-meditation-circles через service-role,
 * сносит pending. Возвращает свежий SessionReport (фронт может сразу его
 * отрисовать без второго запроса).
 *
 * Auth: user JWT — RLS гарантирует, что пользователь правит только свою сессию.
 * Compute-circles требует service-role, поэтому держим его в env и вызываем
 * fetch'ем под капотом.
 *
 * Deploy: supabase functions deploy submit-session-context */

import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'

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

type SubmitRequest = {
  session_id: string
  kind: 'regular' | 'preview'
  circles: number
  /* exactly one of these: */
  location_id?: string         // existing location
  location_name?: string       // new location to create
  distracted: 'никто' | 'немного' | 'сильно'
  self_rating: number          // 1..5
  user_note?: string | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json({ error: 'server_misconfigured' }, 500)
  }

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth) return json({ error: 'unauthorized' }, 401)
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: auth } },
  })

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  let body: SubmitRequest
  try { body = await req.json() as SubmitRequest } catch { return json({ error: 'invalid_json' }, 400) }

  /* Validate. */
  const v = validateRequest(body)
  if (v) return json({ error: 'validation_failed', message: v }, 400)

  /* RLS will block this if it's not the user's session. */
  const { data: session, error: sErr } = await supabase
    .from('meditation_sessions')
    .select('id, user_id, circles')
    .eq('id', body.session_id)
    .maybeSingle()
  if (sErr) return json({ error: 'db_error', message: sErr.message }, 500)
  if (!session) return json({ error: 'not_found' }, 404)

  /* Resolve location: either existing id, or a new one to insert. */
  let locationId: string | null = null
  if (body.location_id) {
    locationId = body.location_id
  } else if (body.location_name && body.location_name.trim()) {
    const slug = makeSlug(body.location_name)
    const { data: existing } = await supabase
      .from('locations')
      .select('id')
      .eq('user_id', user.id)
      .eq('key', slug)
      .maybeSingle()
    if (existing) {
      locationId = existing.id as string
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from('locations')
        .insert({
          user_id: user.id, key: slug, name: body.location_name.trim(),
          country: '', lat: 0, lon: 0, timezone: 'Europe/Moscow',
        })
        .select('id')
        .single()
      if (insErr) return json({ error: 'db_error', message: insErr.message }, 500)
      locationId = inserted.id as string
    }
  }

  /* Update session fields the bot dialog would set. session_kind only flips
   * to 'preview' when explicitly chosen; same for excluded_from_stats. */
  const update: Record<string, unknown> = {
    distracted: body.distracted,
    self_rating: body.self_rating,
    user_note: body.user_note ?? null,
  }
  if (locationId) update.location_id = locationId
  if (body.kind === 'preview') {
    update.session_kind = 'preview'
    update.excluded_from_stats = true
    update.excluded_reason = 'preview'
    update.excluded_at = new Date().toISOString()
  } else if (body.kind === 'regular') {
    /* Stays regular by default; if previously preview and user picks regular,
     * we explicitly un-exclude. */
    update.session_kind = 'regular'
    update.excluded_from_stats = false
    update.excluded_reason = null
    update.excluded_at = null
  }

  const { error: uErr } = await supabase
    .from('meditation_sessions')
    .update(update)
    .eq('id', body.session_id)
  if (uErr) return json({ error: 'db_update_failed', message: uErr.message }, 500)

  /* Call compute-meditation-circles with service-role — sets circles and computes
   * everything downstream (deepening, tags, interpretations, baseline recompute). */
  const computeResp = await callCompute(supabaseUrl, serviceKey, {
    user_id: user.id, session_id: body.session_id, circles: body.circles,
  })
  if (!computeResp.ok) {
    return json({ error: 'compute_failed', detail: computeResp.body }, 500)
  }

  /* Clean up any lingering pending row. */
  await supabase
    .from('meditation_pending_session')
    .delete()
    .eq('user_id', user.id)

  return json({ ok: true, session_id: body.session_id })
})

/* ── helpers ───────────────────────────────────────────────────────────── */

function validateRequest(r: SubmitRequest): string | null {
  if (!r.session_id) return 'session_id required'
  if (r.kind !== 'regular' && r.kind !== 'preview') return 'kind must be regular|preview'
  if (!Number.isInteger(r.circles) || r.circles < 1 || r.circles > 200) return 'circles must be 1..200'
  if (!r.location_id && !r.location_name) return 'location_id or location_name required'
  if (!['никто', 'немного', 'сильно'].includes(r.distracted)) return 'distracted must be никто|немного|сильно'
  if (!Number.isInteger(r.self_rating) || r.self_rating < 1 || r.self_rating > 5) return 'self_rating must be 1..5'
  return null
}

async function callCompute(supabaseUrl: string, serviceKey: string, body: unknown) {
  const resp = await fetch(`${supabaseUrl}/functions/v1/compute-meditation-circles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await resp.text()
  let parsed: unknown = text
  try { parsed = JSON.parse(text) } catch { /* keep as text */ }
  return { ok: resp.ok, body: parsed, status: resp.status }
}

function makeSlug(text: string): string {
  const base = text.trim().toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9 _-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 40)
  return base || `custom_${Date.now()}`
}
