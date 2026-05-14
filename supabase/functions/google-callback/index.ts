/* Edge Function: google-callback
 * OAuth2 callback от Google. Сюда Google редиректит после авторизации
 * с ?code=... и ?state=<user_id>.
 *
 * Шаги:
 *   1. Обменивает code на access_token + refresh_token
 *   2. Кладёт оба токена в supabase_vault
 *   3. Upsert в oauth_tokens (user_id, provider='google')
 *   4. Редиректит пользователя на фронт */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')

  const frontend = Deno.env.get('FRONTEND_URL') ?? 'https://in.adrian.ru'

  if (oauthError) {
    return Response.redirect(
      `${frontend}/morning.html?google=error&reason=${encodeURIComponent(oauthError)}`,
      302,
    )
  }
  if (!code || !state) {
    return new Response('missing code or state', { status: 400 })
  }

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID')!
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET')!
  const redirectUri = Deno.env.get('GOOGLE_REDIRECT_URI')!

  const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  })

  if (!tokenResp.ok) {
    const text = await tokenResp.text()
    console.error('google token exchange failed', tokenResp.status, text)
    return Response.redirect(
      `${frontend}/morning.html?google=error&reason=token_exchange_${tokenResp.status}`,
      302,
    )
  }

  const tokens = await tokenResp.json() as {
    access_token: string
    refresh_token?: string
    expires_in: number
    token_type: string
    scope?: string
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: existing } = await admin
    .from('oauth_tokens')
    .select('access_token_secret_id, refresh_token_secret_id')
    .eq('user_id', state)
    .eq('provider', 'google')
    .maybeSingle()

  let accessSecretId: string
  let refreshSecretId: string | null = null

  if (existing?.access_token_secret_id) {
    await admin.rpc('vault_update', {
      p_id: existing.access_token_secret_id,
      p_value: tokens.access_token,
    })
    accessSecretId = existing.access_token_secret_id
  } else {
    const { data: newId, error: storeErr } = await admin.rpc('vault_store', {
      p_value: tokens.access_token,
      p_name: `google_access_${state}_${Date.now()}`,
    })
    if (storeErr) {
      console.error('vault_store access failed', storeErr)
      return new Response(`vault error: ${storeErr.message}`, { status: 500 })
    }
    accessSecretId = newId as string
  }

  if (tokens.refresh_token) {
    if (existing?.refresh_token_secret_id) {
      await admin.rpc('vault_update', {
        p_id: existing.refresh_token_secret_id,
        p_value: tokens.refresh_token,
      })
      refreshSecretId = existing.refresh_token_secret_id
    } else {
      const { data: newId } = await admin.rpc('vault_store', {
        p_value: tokens.refresh_token,
        p_name: `google_refresh_${state}_${Date.now()}`,
      })
      refreshSecretId = newId as string
    }
  } else {
    refreshSecretId = existing?.refresh_token_secret_id ?? null
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
  const scopes = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : []

  const { error: upsertErr } = await admin.from('oauth_tokens').upsert({
    user_id: state,
    provider: 'google',
    access_token_secret_id: accessSecretId,
    refresh_token_secret_id: refreshSecretId,
    expires_at: expiresAt,
    scopes,
    is_active: true,
    last_error: null,
    last_used_at: new Date().toISOString(),
  }, { onConflict: 'user_id,provider' })

  if (upsertErr) {
    console.error('oauth_tokens upsert failed', upsertErr)
    return new Response(`db error: ${upsertErr.message}`, { status: 500 })
  }

  return Response.redirect(`${frontend}/morning.html?google=connected`, 302)
})
