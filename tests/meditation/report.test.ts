/* Tests for buildSessionReport — pure mapping.
 * Run: deno test --allow-read tests/meditation/report.test.ts */

import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  buildSessionReport, formatDateRu, formatTimeRu, hoursToHm,
  SessionRow, CircleRow,
} from '../../supabase/functions/get-session-report/report.ts'

const baseSession: SessionRow = {
  id: 'sess-123',
  user_id: 'user-1',
  started_at: '2026-05-15T06:37:10.858Z',
  ended_at: '2026-05-15T07:37:48.931Z',
  duration_sec: 3638,
  location_id: 'loc-1',
  session_kind: 'regular',
  excluded_from_stats: false,
  excluded_reason: null,
  circles: 16,
  pace_min_per_circle: 3.79,
  signal_quality_pct: 99.89,
  artifacts_level: 'низкий',
  electrodes_status: { TP9: 'ok', AF7: 'ok', AF8: 'ok', TP10: 'ok' },
  headband_on_pct: 99.89,
  signal_shift_at_sec: null,
  signal_shift_severity: null,
  deepening_reliable: true,
  distracted: 'никто',
  self_rating: 4,
  user_note: null,
  whoop_sleep_hours: 6.5,
  whoop_recovery_pct: 72,
  ab_index_median: 3.01,
  beta_median_rel: 15.33,
  deepening_pct: 63.2,
  longest_calm_sec: 630,
  longest_calm_at_sec: 1620,
  calm_periods_count: 4,
  duration_category: 'standard',
  duration_vs_median_pct: 1.0,
  auto_tags: ['ровная сессия'],
  interpretations: {
    main: 'Умеренное углубление: Theta выросла с 14% до 22%.',
    calm: 'Самый длинный отрезок стабильности — 10 мин 30 сек, начался на 8-м круге.',
    phases: [{ label: 'Плато', range: [1, 16], note: 'Стабильная динамика.' }],
  },
}

const circles16: CircleRow[] = Array.from({ length: 16 }, (_, i) => ({
  circle_num: i + 1,
  alpha_rel: 30 + (i % 3),
  theta_rel: 15 + i * 0.5,
  beta_rel: 12,
  ab_index: 2.5 + (i % 2 ? 0.5 : 0),
}))

const location = { id: 'loc-1', name: 'Москва, дома' }

Deno.test('shape: maps all session-level fields', () => {
  const r = buildSessionReport(baseSession, circles16, location)
  assertEquals(r.id, 'sess-123')
  assertEquals(r.durationMin, 60.6)
  assertEquals(r.circles, 16)
  assertEquals(r.paceMinPerCircle, 3.79)
  assertEquals(r.kind, 'regular')
  assertEquals(r.excludedFromStats, false)
  assertEquals(r.location, { id: 'loc-1', name: 'Москва, дома' })
  assertEquals(r.signal.overall, 99.89)
  assertEquals(r.signal.shift, null)
  assertEquals(r.context.whoopSleep, '6:30')
  assertEquals(r.context.whoopRecovery, 72)
  assertEquals(r.tags, ['ровная сессия'])
})

Deno.test('shape: perCircle reflects circles count and field order', () => {
  const r = buildSessionReport(baseSession, circles16, location)
  assert(r.perCircle !== null)
  assertEquals(r.perCircle!.length, 16)
  assertEquals(r.perCircle![0], { i: 1, alpha: 30, theta: 15, beta: 12 })
  assertEquals(r.perCircle![15].i, 16)
})

Deno.test('compare: three metrics with per-circle today arrays, periods all null, hiddenReason="no_baseline"', () => {
  const r = buildSessionReport(baseSession, circles16, location)
  // Today values
  assertEquals(r.compare.deepening.todayValue, 63.2)
  assertEquals(r.compare.stability.todayValue, 3.01)
  assertEquals(r.compare.beta.todayValue, 15.33)
  // Today per-circle arrays — 16 points
  assertEquals(r.compare.deepening.todayPerCircle.length, 16)
  assertEquals(r.compare.stability.todayPerCircle.length, 16)
  assertEquals(r.compare.beta.todayPerCircle.length, 16)
  // Baseline not computed yet → all periods null, no_baseline
  for (const key of ['deepening', 'stability', 'beta'] as const) {
    assertEquals(r.compare[key].periods.w, null)
    assertEquals(r.compare[key].periods.m, null)
    assertEquals(r.compare[key].periods.q, null)
    assertEquals(r.compare[key].periods.all, null)
    assertEquals(r.compare[key].hiddenReason, 'no_baseline')
  }
})

Deno.test('hiddenReason: preview session → "preview"', () => {
  const s: SessionRow = {
    ...baseSession,
    session_kind: 'preview',
    excluded_from_stats: true,
    excluded_reason: 'preview',
  }
  const r = buildSessionReport(s, circles16, location)
  assertEquals(r.kind, 'preview')
  assertEquals(r.compare.deepening.hiddenReason, 'preview')
  assertEquals(r.compare.stability.hiddenReason, 'preview')
  assertEquals(r.compare.beta.hiddenReason, 'preview')
})

Deno.test('hiddenReason: manually-excluded session → "manual_exclude"', () => {
  const s: SessionRow = {
    ...baseSession,
    excluded_from_stats: true,
    excluded_reason: 'manual',
  }
  const r = buildSessionReport(s, circles16, location)
  assertEquals(r.compare.deepening.hiddenReason, 'manual_exclude')
})

Deno.test('hiddenReason: short / long duration → "nonstandard_duration"', () => {
  const short = buildSessionReport({ ...baseSession, duration_category: 'short' }, circles16, location)
  assertEquals(short.compare.deepening.hiddenReason, 'nonstandard_duration')

  const long = buildSessionReport({ ...baseSession, duration_category: 'long' }, circles16, location)
  assertEquals(long.compare.deepening.hiddenReason, 'nonstandard_duration')
})

Deno.test('hiddenReason: excluded wins over nonstandard duration', () => {
  const s: SessionRow = {
    ...baseSession,
    duration_category: 'short',
    excluded_from_stats: true,
    excluded_reason: 'manual',
  }
  const r = buildSessionReport(s, circles16, location)
  assertEquals(r.compare.deepening.hiddenReason, 'manual_exclude')
})

Deno.test('signal.shift: filled when both at_sec and severity present', () => {
  const s: SessionRow = {
    ...baseSession,
    signal_shift_at_sec: 1620,
    signal_shift_severity: 'high',
    deepening_reliable: false,
  }
  const r = buildSessionReport(s, circles16, location)
  assertEquals(r.signal.shift, { atSec: 1620, atMinute: 27, severity: 'high' })
  assertEquals(r.signal.deepeningReliable, false)
})

Deno.test('perCircle: null when circles not confirmed (empty rows)', () => {
  const s: SessionRow = { ...baseSession, circles: null, pace_min_per_circle: null }
  const r = buildSessionReport(s, [], location)
  assertEquals(r.perCircle, null)
  assertEquals(r.circles, null)
  // compare arrays empty (no circles to derive per-circle from)
  assertEquals(r.compare.deepening.todayPerCircle, [])
})

Deno.test('location: null when no row provided', () => {
  const r = buildSessionReport({ ...baseSession, location_id: null }, circles16, null)
  assertEquals(r.location, null)
})

Deno.test('whoopSleep: null when no Whoop data yet', () => {
  const s: SessionRow = { ...baseSession, whoop_sleep_hours: null, whoop_recovery_pct: null }
  const r = buildSessionReport(s, circles16, location)
  assertEquals(r.context.whoopSleep, null)
  assertEquals(r.context.whoopRecovery, null)
})

Deno.test('interpretations: pass through; null when absent', () => {
  const r = buildSessionReport(baseSession, circles16, location)
  assertEquals(r.caption.main, 'Умеренное углубление: Theta выросла с 14% до 22%.')
  assertEquals(r.phases!.length, 1)

  const empty = buildSessionReport({ ...baseSession, interpretations: null }, circles16, location)
  assertEquals(empty.caption.main, null)
  assertEquals(empty.caption.calm, null)
  assertEquals(empty.phases, null)
})

Deno.test('formatDateRu: ru-RU long form with weekday', () => {
  const s = formatDateRu('2026-05-15T06:37:10.858Z')
  assert(s.includes('15') && s.includes('мая') && s.includes('2026'))
  assert(s.includes('пятница') || s.includes('четверг'),
    `weekday missing in "${s}"`)
})

Deno.test('formatTimeRu: HH:MM from UTC ISO', () => {
  assertEquals(formatTimeRu('2026-05-15T06:37:10.858Z'), '06:37')
  assertEquals(formatTimeRu('2026-05-15T07:37:48.931Z'), '07:37')
})

Deno.test('hoursToHm: rounds minutes correctly, carries at 60', () => {
  assertEquals(hoursToHm(6.5), '6:30')
  assertEquals(hoursToHm(7.0), '7:00')
  assertEquals(hoursToHm(7.25), '7:15')
  assertEquals(hoursToHm(8.99), '8:59')      // 0.99×60 = 59.4 → 59
  assertEquals(hoursToHm(8.999), '9:00')     // 0.999×60 = 59.94 → 60 → carry
})
