/* Edge Function: morning-message
 * Возвращает фронту утреннее обращение Пандитджи: курсивный текст в шапке.
 * Кэш: одно сообщение на (user, today_local, kind='morning'); если ещё нет —
 * собираем контекст (сон, recovery, события, погода) и просим Claude. */

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CLAUDE_API = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-sonnet-4-5'

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

function localDate(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/* Краткий выжимок из docs/language-guide.md — главное, что нужно Claude в каждом вызове.
   Полный гайд большой; здесь — то, без чего сообщение получается коучским. */
const VOICE_GUIDE = `
Ты — Пандитджи. Не приложение, не врач, не коуч. Тёплый восточный друг с долгим опытом.
Камертон — Ходжа Насреддин у Соловьёва: неторопливость, тёплая ирония, точность короткой фразы, уважение.

Регистры (выбирай один на сообщение, не повторяй регистр со вчерашнего раза):
  morning_soft   — основной утренний: «Ачинтья джи, дорогой, доброе утро. Спал ровно, HRV крепкий.»
  lukavy         — лукавый: «Спал девять часов. Это первый зарегистрированный случай за месяц.»
  svoyskiy       — свойский: «Послезавтра Экадаши. Имей в виду.»
  serious        — серьёзный: для важных фактов с трендом
  warm_uplifted  — тёплый-приподнятый: для радости
  sympathetic    — сочувственный: «Не печалься. Ночь была тяжёлая, но это пройдёт.»

Приёмы Соловьёва (использовать в меру, не все сразу):
  • Длинное дыхание + короткая нота — главный ритм важных сообщений.
  • «Ибо» вместо «потому что» — мягко, не в каждом сообщении.
  • «Не …, а …» — мягкое противопоставление.
  • «Однако» как поворот.
  • «Не печалься / не тревожься» — только если повод действительно есть.
  • Сравнения с «подобно/словно» — не чаще одного на сообщение.

Обращения:
  «Ачинтья джи, дорогой» — чаще всего.
  «Ачинтья джи» — нейтральное.
  «Дорогой» / «Друг мой» — изредка.
  «Свет очей моих» — раз в неделю-две, не чаще.

Запрещено:
  — Коучский регистр: «работай над собой», «выходи из зоны комфорта», «ты можешь!».
  — Геймификация: streak, achievement, проценты как трофеи.
  — Кальки с английского: «обрати внимание», «прислушайся к себе», «как насчёт того, чтобы».
  — Псевдо-восточные манерности: «ой, вай», «иншалла».
  — Сюсюканье: «солнышко», «миленький».
  — Эмодзи и иконки в тексте.
  — Лекции о пользе сна, длинные оговорки.

Длина: 1–3 предложения. Длиннее — только в редких содержательных случаях.
Если данных нет — не выдумывай. Лучше сказать короче.

Можно использовать <em>…</em> для одного-двух выделений (название накшатры, точка особого упоминания).
Никакого markdown, никакого JSON. Только готовый текст сообщения. Никаких преамбул вроде "Вот сообщение:".
`.trim()

async function generateMessage(context: Record<string, unknown>): Promise<string | null> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return null

  const userPrompt = `Сегодня ${context.today_human}. Адриан (Ачинтья джи) в локации: ${context.location}.

Контекст утра:
${JSON.stringify(context, null, 2)}

Напиши одно утреннее сообщение для шапки экрана. 1-3 предложения. Голос — как описано в системе.`

  const resp = await fetch(CLAUDE_API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: VOICE_GUIDE,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })

  if (!resp.ok) {
    console.error('claude error', resp.status, await resp.text())
    return null
  }

  const data = await resp.json() as { content: Array<{ type: string; text: string }> }
  const text = data.content.find((b) => b.type === 'text')?.text?.trim() ?? ''
  return text || null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'missing authorization' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!

  const db = createClient(supabaseUrl, anon, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: userErr } = await db.auth.getUser()
  if (userErr || !user) return json({ error: 'invalid token' }, 401)

  /* Профиль + локация → определяем дату/зону пользователя. */
  const { data: profile } = await db
    .from('user_profile')
    .select('short_name, current_location_id')
    .eq('id', user.id)
    .single()
  if (!profile) return json({ error: 'no profile' }, 404)

  let tz = 'Europe/Moscow'
  let locationName = ''
  if (profile.current_location_id) {
    const { data: loc } = await db.from('locations')
      .select('name, timezone, id')
      .eq('id', profile.current_location_id)
      .maybeSingle()
    if (loc) { tz = loc.timezone; locationName = loc.name }
  }
  const today = localDate(tz)

  /* Кэш: уже есть утреннее сообщение за сегодня? */
  const { data: cached } = await db
    .from('messages')
    .select('content, generated_at')
    .eq('date', today)
    .eq('kind', 'morning')
    .maybeSingle()
  if (cached) {
    return json({ content: cached.content, cached: true })
  }

  /* Параллельно собираем контекст утра. */
  const [recoveryRes, eventsRes, weatherRes] = await Promise.all([
    db.from('whoop_recovery')
      .select('recovery_score, hrv_rmssd_ms, resting_heart_rate, sleep_id')
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('calendar_events')
      .select('title, start_at, end_at, is_all_day')
      .gte('start_at', new Date(Date.now() - 12 * 3600_000).toISOString())
      .lte('start_at', new Date(Date.now() + 36 * 3600_000).toISOString())
      .is('deleted_at', null)
      .order('start_at'),
    db.from('weather_log')
      .select('temperature_c, measured_at')
      .eq('location_id', profile.current_location_id)
      .order('measured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  let sleep: Record<string, unknown> | null = null
  if (recoveryRes.data?.sleep_id) {
    const { data: s } = await db.from('whoop_sleeps')
      .select('duration_seconds, sleep_efficiency, start_at, end_at')
      .eq('id', recoveryRes.data.sleep_id)
      .maybeSingle()
    if (s) {
      const dur = s.duration_seconds ?? 0
      sleep = {
        hours: Math.floor(dur / 3600),
        minutes: Math.floor((dur % 3600) / 60),
        efficiency_pct: s.sleep_efficiency,
        end_local: new Intl.DateTimeFormat('ru-RU', {
          timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(s.end_at as string)),
      }
    }
  }

  /* События только за сегодня в зоне пользователя. */
  const todaysEvents = (eventsRes.data ?? []).filter((ev: any) => {
    const evLocal = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ev.start_at))
    return evLocal === today
  }).map((ev: any) => ({
    title: ev.title,
    time: ev.is_all_day ? null : new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ev.start_at)),
  }))

  const todayHuman = new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date())

  const context = {
    today_iso: today,
    today_human: todayHuman,
    location: locationName || 'неизвестно',
    timezone: tz,
    short_name: profile.short_name,
    weather: weatherRes.data ? {
      temperature_c: Number(weatherRes.data.temperature_c),
    } : null,
    sleep,
    recovery: recoveryRes.data ? {
      score: recoveryRes.data.recovery_score,
      hrv_ms: recoveryRes.data.hrv_rmssd_ms ? Number(recoveryRes.data.hrv_rmssd_ms) : null,
      resting_hr: recoveryRes.data.resting_heart_rate,
    } : null,
    today_events: todaysEvents,
  }

  const content = await generateMessage(context)
  if (!content) {
    return json({ error: 'generation failed' }, 502)
  }

  /* Сохраняем кэш. */
  await db.from('messages').insert({
    user_id: user.id,
    date: today,
    kind: 'morning',
    content,
    model: CLAUDE_MODEL,
    context_snapshot: context,
  })

  return json({ content, cached: false })
})
