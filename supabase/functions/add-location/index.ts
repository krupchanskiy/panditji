/* Edge Function: add-location
 *
 * Добавляет новую локацию в `locations` и триггерит GHA-workflow для пересчёта
 * vaishnava_calendar + vaishnava_panchanga под эту локацию.
 *
 * POST body: { key, name, country, lat, lon, timezone }
 * Auth:      JWT пользователя
 * Secrets:   GH_PAT — токен с workflow scope для запуска dispatch
 */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const url = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'missing auth' }, 401)

  const supabase = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'invalid body' }, 400) }

  const { key, name, country, lat, lon, timezone } = body
  if (!key || !name || !country || lat == null || lon == null || !timezone) {
    return json({ error: 'key, name, country, lat, lon, timezone required' }, 400)
  }

  // 1) INSERT в locations с фолбэком если уже есть
  const insertRes = await supabase
    .from('locations')
    .upsert({
      user_id: user.id,
      key, name, country,
      lat, lon, timezone,
      is_primary: false,
    }, { onConflict: 'user_id,key' })
    .select('id, key, name')
    .single()

  if (insertRes.error) {
    return json({ error: 'failed to insert: ' + insertRes.error.message }, 500)
  }
  const locationId = insertRes.data.id

  // 2) Триггерим GHA workflow_dispatch — нужен PAT с workflow scope
  const pat = Deno.env.get('GH_PAT')
  if (!pat) {
    return json({
      location_id: locationId,
      location: insertRes.data,
      gha_triggered: false,
      warning: 'GH_PAT not set; calendar данные появятся при ближайшем плановом запуске',
    })
  }

  // GitHub repository/workflow dispatch
  const ghRes = await fetch(
    'https://api.github.com/repos/krupchanskiy/panditji/actions/workflows/vaishnava-calendar.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${pat}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: 'main', inputs: { years_ahead: '2', dry_run: '0' } }),
    },
  )
  const ghOk = ghRes.status >= 200 && ghRes.status < 300

  return json({
    location_id: locationId,
    location: insertRes.data,
    gha_triggered: ghOk,
    gha_status: ghRes.status,
  })
})
