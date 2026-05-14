/* Edge Function: whoop-init
 * Возвращает фронту URL для перехода на Whoop OAuth.
 * state = user.id (для single-user приложения этого достаточно). */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth'
const SCOPES = 'offline read:profile read:recovery read:sleep read:workout'

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

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'missing authorization' }, 401)

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const { data: { user }, error } = await db.auth.getUser()
  if (error || !user) return json({ error: 'invalid token' }, 401)

  const clientId = Deno.env.get('WHOOP_CLIENT_ID')
  const redirectUri = Deno.env.get('WHOOP_REDIRECT_URI')
  if (!clientId || !redirectUri) {
    return json({ error: 'whoop not configured on server' }, 500)
  }

  const url = new URL(WHOOP_AUTH_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('state', user.id)

  return json({ auth_url: url.toString() })
})
