/* Edge Function: google-init
 * Возвращает фронту URL для перехода в Google OAuth.
 * Scope = calendar read+write (на будущее, чтобы Telegram-бот мог создавать события).
 * state = user.id. */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly'

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

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
  const redirectUri = Deno.env.get('GOOGLE_REDIRECT_URI')
  if (!clientId || !redirectUri) {
    return json({ error: 'google not configured on server' }, 500)
  }

  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', user.id)

  return json({ auth_url: url.toString() })
})
