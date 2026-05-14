/* Edge Function: whoop-callback
 * OAuth2 callback от Whoop. Сюда Whoop редиректит после авторизации
 * с ?code=... и ?state=<user_id>.
 *
 * Шаги:
 *   1. Обменивает code на access_token + refresh_token
 *   2. Кладёт оба токена в supabase_vault (через RPC vault_store/update)
 *   3. Upsert в oauth_tokens (user_id, provider='whoop')
 *   4. Редиректит пользователя на фронт
 *
 * Безопасность: state = user_id; для single-user приложения этого достаточно.
 * Edge Function задеплоен с verify_jwt: false, т.к. Whoop редиректит браузер
 * без нашего JWT в заголовках. Проверка вшита в обмен auth_code (он одноразовый
 * и привязан к нашему redirect_uri в Whoop dev portal). */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token'

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')

  const frontend = Deno.env.get('FRONTEND_URL') ?? 'https://in.adrian.ru'

  if (oauthError) {
    return Response.redirect(
      `${frontend}/morning.html?whoop=error&reason=${encodeURIComponent(oauthError)}`,
      302,
    )
  }
  if (!code || !state) {
    return new Response('missing code or state', { status: 400 })
  }

  const clientId = Deno.env.get('WHOOP_CLIENT_ID')!
  const clientSecret = Deno.env.get('WHOOP_CLIENT_SECRET')!
  const redirectUri = Deno.env.get('WHOOP_REDIRECT_URI')!

  /* Обмен auth_code на токены. */
  const tokenResp = await fetch(WHOOP_TOKEN_URL, {
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
    console.error('whoop token exchange failed', tokenResp.status, text)
    return Response.redirect(
      `${frontend}/morning.html?whoop=error&reason=token_exchange_${tokenResp.status}`,
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

  /* Если запись OAuth уже есть — обновляем секреты, иначе создаём новые. */
  const { data: existing } = await admin
    .from('oauth_tokens')
    .select('access_token_secret_id, refresh_token_secret_id')
    .eq('user_id', state)
    .eq('provider', 'whoop')
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
      p_name: `whoop_access_${state}_${Date.now()}`,
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
        p_name: `whoop_refresh_${state}_${Date.now()}`,
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
    provider: 'whoop',
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

  return Response.redirect(`${frontend}/morning.html?whoop=connected`, 302)
})
