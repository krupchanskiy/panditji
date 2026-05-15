/* Date helpers — all in user's local TZ.
 * `today` is the source of truth from the page bootstrap (recomputed each minute). */

const WEEKDAYS_NOM = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']
const WEEKDAYS_GEN = ['воскресенья', 'понедельника', 'вторника', 'среды', 'четверга', 'пятницы', 'субботы']
const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]
const MONTHS_NOM = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
]

/* Today as YYYY-MM-DD in given TZ. */
export function localDate(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/* Parse YYYY-MM-DD to {y,m,d} without TZ shift. */
export function parseISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m, d }
}

/* Day diff between two ISO date-only strings (b - a). */
export function dayDiff(a, b) {
  const da = parseISODate(a)
  const db = parseISODate(b)
  const ms = Date.UTC(db.y, db.m - 1, db.d) - Date.UTC(da.y, da.m - 1, da.d)
  return Math.round(ms / 86400000)
}

/* Add N days to an ISO date, returning ISO YYYY-MM-DD. */
export function addDays(iso, n) {
  const { y, m, d } = parseISODate(iso)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/* Weekday index 0..6 (0=Sun) for an ISO date treated as plain calendar. */
export function dowOf(iso) {
  const { y, m, d } = parseISODate(iso)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/* Nearest given weekday strictly after `from`. dow 0..6. */
export function nextWeekday(from, targetDow) {
  const cur = dowOf(from)
  let delta = (targetDow - cur + 7) % 7
  if (delta === 0) delta = 7
  return addDays(from, delta)
}

/* Render due-date as "Сегодня" / "Завтра" / weekday / absolute month-day. */
export function formatDue(today, dueDate) {
  const diff = dayDiff(today, dueDate)
  if (diff === 0) return 'Сегодня'
  if (diff === 1) return 'Завтра'
  if (diff === -1) return 'Вчера'
  if (diff >= 2 && diff <= 6) {
    const wd = WEEKDAYS_NOM[dowOf(dueDate)]
    return wd[0].toUpperCase() + wd.slice(1)
  }
  const { m, d } = parseISODate(dueDate)
  return `${d} ${MONTHS_GEN[m - 1]}`
}

/* Render "хвост" date relative to today: "с пятницы", "вчера", "3 дня назад", absolute. */
export function formatTail(today, dueDate) {
  const diff = dayDiff(today, dueDate)
  if (diff === -1) return 'вчера'
  if (diff <= -2 && diff >= -6) return `с ${WEEKDAYS_GEN[dowOf(dueDate)]}`
  if (diff <= -7 && diff >= -30) {
    const days = Math.abs(diff)
    const tail = pluralize(days, 'день', 'дня', 'дней')
    return `${days} ${tail} назад`
  }
  const { m, d } = parseISODate(dueDate)
  return `${d} ${MONTHS_GEN[m - 1]}`
}

/* Date for topbar greeting: "14 МАЯ · ЧЕТВЕРГ". */
export function formatTopbarDate(today) {
  const { m, d } = parseISODate(today)
  const wd = WEEKDAYS_NOM[dowOf(today)].toUpperCase()
  return `${d} ${MONTHS_GEN[m - 1].toUpperCase()} · ${wd}`
}

/* Long human date "8 мая · 16:42" — used in details sheet `СОЗДАНО`. */
export function formatCreatedAt(iso) {
  const dt = new Date(iso)
  const d = dt.getDate()
  const m = dt.getMonth()
  const hh = String(dt.getHours()).padStart(2, '0')
  const mm = String(dt.getMinutes()).padStart(2, '0')
  return `${d} ${MONTHS_GEN[m]} · ${hh}:${mm}`
}

/* "Май 2026" for calendar header. */
export function formatCalMonth(y, m) {
  const name = MONTHS_NOM[m - 1]
  return `${name[0].toUpperCase() + name.slice(1)} ${y}`
}

/* Russian plural: pluralize(2, 'день', 'дня', 'дней') → 'дня'. */
export function pluralize(n, one, few, many) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a >= 11 && a <= 14) return many
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}

/* HH:MM badge — passthrough if already in canonical form, else null. */
export function formatTime(hhmm) {
  if (!hhmm) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm)
  if (!m) return null
  const h = Math.max(0, Math.min(23, Number(m[1])))
  return `${String(h).padStart(2, '0')}:${m[2]}`
}
