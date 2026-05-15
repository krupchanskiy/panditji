/* Минимальный Supabase-хаб. Импортируется страницами через type="module". */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const SUPABASE_URL = 'https://intcymsjpbkyrflfcwzf.supabase.co'
export const SUPABASE_KEY = 'sb_publishable_IgyFEUad8sMGQSacSj3L_Q_NciIqamm'

export const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

/* Auth-First: вызывать в начале каждой защищённой страницы.
 * Возвращает user или редиректит на /. */
export async function requireAuth() {
  const { data: { session } } = await db.auth.getSession()
  if (!session) {
    window.location.replace('/login.html')
    return null
  }
  return session.user
}

export async function logout() {
  await db.auth.signOut()
  window.location.replace('/login.html')
}

/* Локальная дата пользователя (YYYY-MM-DD) в его часовой зоне.
 * date-only поля в БД хранятся как локальная дата, не UTC. */
export function localDate(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/* Русские названия месяцев в родительном падеже («14 мая», а не «14 май»). */
const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

/* Дата для шапки утреннего экрана: { weekday, day, month }. */
export function formatHeaderDate(tz) {
  const now = new Date()
  const weekday = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'long' }).format(now)
  const day = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, day: 'numeric' }).format(now))
  const monthIdx = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: 'numeric' }).format(now)) - 1
  return { weekday, day, month: MONTHS_GEN[monthIdx] }
}
