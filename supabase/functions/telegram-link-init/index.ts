/* Edge Function: telegram-link-init
 * Генерирует одноразовый токен привязки и возвращает фронту deep-link
 * в Telegram-бота. Пользователь жмёт ссылку, бот видит /start <token>
 * и связывает свой chat_id с этим user_id. */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const BOT_USERNAME = 'panditjiji_bot'

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

function generateToken(): string {
  /* 32 байта → base64url ≈ 43 символа без +/= */
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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
  const { data: { user }, error: userErr } = await db.auth.getUser()
  if (userErr || !user) return json({ error: 'invalid token' }, 401)

  const token = generateToken()

  /* Записываем токен в профиль текущего пользователя (RLS пропустит — это его же запись). */
  const { error: updErr } = await db
    .from('user_profile')
    .update({ telegram_link_token: token })
    .eq('id', user.id)

  if (updErr) return json({ error: updErr.message }, 500)

  return json({
    deep_link: `https://t.me/${BOT_USERNAME}?start=${token}`,
    bot_username: BOT_USERNAME,
  })
})
