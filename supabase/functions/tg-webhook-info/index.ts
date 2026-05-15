/* Diagnostic + fix endpoint for the Telegram webhook subscription.
 *
 *   GET  /functions/v1/tg-webhook-info           — getWebhookInfo
 *   GET  /functions/v1/tg-webhook-info?fix=1     — re-call setWebhook with
 *                                                  allowed_updates including
 *                                                  callback_query.
 *
 * No auth (read-only metadata + idempotent re-subscribe). Safe to leave in place
 * but can be deleted once webhook subscription is settled. */

const TG_API = 'https://api.telegram.org'

Deno.serve(async (req) => {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  if (!token) return new Response('TELEGRAM_BOT_TOKEN missing', { status: 500 })

  const url = new URL(req.url)
  if (url.searchParams.get('fix') === '1') {
    const secret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')
    const webhookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/telegram-webhook`
    const body: Record<string, unknown> = {
      url: webhookUrl,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
    }
    if (secret) body.secret_token = secret
    const resp = await fetch(`${TG_API}/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return new Response(await resp.text(), {
      headers: { 'Content-Type': 'application/json' },
      status: resp.status,
    })
  }

  const resp = await fetch(`${TG_API}/bot${token}/getWebhookInfo`)
  return new Response(await resp.text(), {
    headers: { 'Content-Type': 'application/json' },
    status: resp.status,
  })
})
