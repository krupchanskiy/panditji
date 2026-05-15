/* Tests for buildTrendsReport + filters + SMA-7.
 * Run: deno test --allow-read tests/meditation/trends.test.ts */

import { assert, assertEquals } from 'jsr:@std/assert@1'
import {
  buildTrendsReport, isIncludedInTrends, isIncludedInAggregates, isCalm,
  SessionForTrends,
} from '../../supabase/functions/get-trends-report/trends.ts'

function makeSession(overrides: Partial<SessionForTrends> = {}): SessionForTrends {
  return {
    id: 'sess-' + Math.random().toString(36).slice(2, 8),
    started_at: '2026-05-15T06:37:10.858Z',
    duration_sec: 3600,
    circles: 16,
    pace_min_per_circle: 3.75,
    signal_quality_pct: 99,
    signal_shift_severity: null,
    deepening_reliable: true,
    deepening_pct: 50,
    ab_index_median: 3.0,
    longest_calm_sec: 600,
    duration_category: 'standard',
    whoop_sleep_hours: 6.5,
    whoop_recovery_pct: 72,
    distracted: 'никто',
    self_rating: 4,
    auto_tags: [],
    excluded_from_stats: false,
    location_name: 'Москва, дома',
    ...overrides,
  }
}

const now = new Date('2026-05-15T12:00:00Z')

/* ── filters ───────────────────────────────────────────────────────────── */

Deno.test('isIncludedInTrends: rejects excluded sessions', () => {
  assertEquals(isIncludedInTrends(makeSession()), true)
  assertEquals(isIncludedInTrends(makeSession({ excluded_from_stats: true })), false)
  assertEquals(isIncludedInTrends(makeSession({ circles: null })), false)
})

Deno.test('isIncludedInAggregates: also rejects nonstandard duration', () => {
  assertEquals(isIncludedInAggregates(makeSession()), true)
  assertEquals(isIncludedInAggregates(makeSession({ duration_category: null })), true)
  assertEquals(isIncludedInAggregates(makeSession({ duration_category: 'short' })), false)
  assertEquals(isIncludedInAggregates(makeSession({ duration_category: 'long' })), false)
})

Deno.test('isCalm: technical-quality only, NOT self_rating or distracted', () => {
  // Strong technical → calm
  assertEquals(isCalm(makeSession({ signal_quality_pct: 95 })), true)
  // High distracted, low rating — still calm (only tech quality matters)
  assertEquals(isCalm(makeSession({ self_rating: 1, distracted: 'сильно' })), true)
  // Failures
  assertEquals(isCalm(makeSession({ signal_quality_pct: 70 })), false)
  assertEquals(isCalm(makeSession({ auto_tags: ['технические проблемы'] })), false)
  assertEquals(isCalm(makeSession({ signal_shift_severity: 'high' })), false)
  assertEquals(isCalm(makeSession({ deepening_reliable: false })), false)
})

/* ── shape ────────────────────────────────────────────────────────────── */

Deno.test('shape: empty input → zeros, nulls, empty arrays', () => {
  const r = buildTrendsReport({ period: 30, calmOnly: false, now, sessions: [] })
  assertEquals(r.period, 30)
  assertEquals(r.total, 0)
  assertEquals(r.totalMinutes, 0)
  assertEquals(r.avgDuration, null)
  assertEquals(r.avgPerCircle, null)
  assertEquals(r.goodSignalPercent, null)
  assertEquals(r.sessions, [])
  assertEquals(r.sma7Deepening, [])
  assertEquals(r.sma7Ab, [])
  assertEquals(r.avgCalmNormalized, null)
  assertEquals(r.avgAllNormalized, null)
  // correlations now always present (shape stable, content "недостаточно данных")
  assert(r.correlations !== null)
  assertEquals(r.correlations.sleepVsDeepening.n, 0)
  assertEquals(r.correlations.distractedVsDeepening.groups.length, 3)
})

Deno.test('sessions: maps to TrendSession with idx, date, isToday', () => {
  const sessions = [
    makeSession({ started_at: '2026-05-10T06:00:00Z' }),
    makeSession({ started_at: '2026-05-15T06:00:00Z' }),  // today
  ]
  const r = buildTrendsReport({ period: 30, calmOnly: false, now, sessions })
  assertEquals(r.sessions.length, 2)
  assertEquals(r.sessions[0].idx, 0)
  assertEquals(r.sessions[0].date, '10.05')
  assertEquals(r.sessions[0].isToday, false)
  assertEquals(r.sessions[1].idx, 1)
  assertEquals(r.sessions[1].date, '15.05')
  assertEquals(r.sessions[1].isToday, true)
})

Deno.test('sessions: sorted by date ascending regardless of input order', () => {
  const sessions = [
    makeSession({ id: 'c', started_at: '2026-05-13T06:00:00Z' }),
    makeSession({ id: 'a', started_at: '2026-05-10T06:00:00Z' }),
    makeSession({ id: 'b', started_at: '2026-05-12T06:00:00Z' }),
  ]
  const r = buildTrendsReport({ period: 30, calmOnly: false, now, sessions })
  assertEquals(r.sessions.map(s => s.id), ['a', 'b', 'c'])
})

Deno.test('sessions: excluded/incomplete filtered out before mapping', () => {
  const sessions = [
    makeSession({ id: 'ok' }),
    makeSession({ id: 'excluded', excluded_from_stats: true }),
    makeSession({ id: 'no_circles', circles: null }),
  ]
  const r = buildTrendsReport({ period: 30, calmOnly: false, now, sessions })
  assertEquals(r.sessions.length, 1)
  assertEquals(r.sessions[0].id, 'ok')
})

Deno.test('deepening: null in TrendSession when not reliable', () => {
  const r = buildTrendsReport({
    period: 30, calmOnly: false, now,
    sessions: [
      makeSession({ id: 'reliable', deepening_reliable: true, deepening_pct: 60 }),
      makeSession({ id: 'shifted', deepening_reliable: false, deepening_pct: 345 }),
    ],
  })
  assertEquals(r.sessions[0].deepening, 60)
  assertEquals(r.sessions[1].deepening, null)   // hidden even though raw value exists
})

Deno.test('totals: count and totalMinutes over visible sessions', () => {
  const r = buildTrendsReport({
    period: 30, calmOnly: false, now,
    sessions: [
      makeSession({ duration_sec: 3600 }),         // 60 min
      makeSession({ duration_sec: 1800 }),         // 30 min
      makeSession({ duration_sec: 3600, excluded_from_stats: true }),  // hidden
    ],
  })
  assertEquals(r.total, 2)
  assertEquals(r.totalMinutes, 90)
  assertEquals(r.avgDuration, 45)
})

Deno.test('avgPerCircle: uses aggregate set, excludes short/long sessions', () => {
  const r = buildTrendsReport({
    period: 30, calmOnly: false, now,
    sessions: [
      makeSession({ pace_min_per_circle: 3.5 }),
      makeSession({ pace_min_per_circle: 4.0 }),
      makeSession({ pace_min_per_circle: 1.5, duration_category: 'short' }),  // excluded
    ],
  })
  assertEquals(r.avgPerCircle, 3.8)   // (3.5+4.0)/2 = 3.75 → rounded 1dp
  // But the short session is still visible in sessions[]:
  assertEquals(r.sessions.length, 3)
})

/* ── SMA-7 ─────────────────────────────────────────────────────────────── */

Deno.test('SMA-7: requires ≥3 values to publish, grows up to 7 wide', () => {
  // 10 sessions, each with deepening 10..100 step 10.
  const sessions = Array.from({ length: 10 }, (_, i) => makeSession({
    id: 'i' + i,
    started_at: `2026-05-${String(5 + i).padStart(2, '0')}T06:00:00Z`,
    deepening_pct: (i + 1) * 10,
  }))
  const r = buildTrendsReport({ period: 30, calmOnly: false, now, sessions })

  // First 2 → null (window too small).
  assertEquals(r.sma7Deepening[0], null)
  assertEquals(r.sma7Deepening[1], null)
  // Third onward → published.
  assert(r.sma7Deepening[2] !== null)
  // At i=6, window is sessions 0..6 → mean(10..70) = 40.
  assertEquals(r.sma7Deepening[6], 40)
  // At i=9, window is sessions 3..9 → mean(40..100) = 70.
  assertEquals(r.sma7Deepening[9], 70)
})

Deno.test('SMA-7: nonstandard duration session in middle does not count toward window', () => {
  const sessions = [
    makeSession({ id: '0', started_at: '2026-05-01T06:00:00Z', deepening_pct: 10 }),
    makeSession({ id: '1', started_at: '2026-05-02T06:00:00Z', deepening_pct: 20 }),
    makeSession({ id: '2', started_at: '2026-05-03T06:00:00Z', deepening_pct: 99, duration_category: 'short' }),  // visible but not aggregated
    makeSession({ id: '3', started_at: '2026-05-04T06:00:00Z', deepening_pct: 40 }),
  ]
  const r = buildTrendsReport({ period: 30, calmOnly: false, now, sessions })
  // SMA at idx=3 should be mean(10, 20, 40) = 23.33, NOT include the 99 outlier.
  assertEquals(r.sma7Deepening[3], 23.33)
  // The short session itself has SMA null (not in aggregate set).
  assertEquals(r.sma7Deepening[2], null)
  // But it is still visible in sessions[].
  assertEquals(r.sessions.length, 4)
})

Deno.test('SMA-7: AB-index parallel computation', () => {
  const sessions = Array.from({ length: 5 }, (_, i) => makeSession({
    id: 'i' + i,
    started_at: `2026-05-${String(5 + i).padStart(2, '0')}T06:00:00Z`,
    ab_index_median: i + 1,
  }))
  const r = buildTrendsReport({ period: 30, calmOnly: false, now, sessions })
  assertEquals(r.sma7Ab[0], null)
  assertEquals(r.sma7Ab[1], null)
  assertEquals(r.sma7Ab[2], 2)        // mean(1,2,3)
  assertEquals(r.sma7Ab[4], 3)        // mean(1..5)
})

/* ── calm-only flag ─────────────────────────────────────────────────────── */

/* ── baseline normalized averages ──────────────────────────────────────── */

Deno.test('normalized baselines: pass through to TrendsReport unchanged', () => {
  const calm = {
    alpha: Array.from({ length: 16 }, () => 30),
    theta: Array.from({ length: 16 }, () => 15),
    beta:  Array.from({ length: 16 }, () => 13),
    ab:    Array.from({ length: 16 }, () => 2.5),
  }
  const r = buildTrendsReport({
    period: 30, calmOnly: true, now, sessions: [makeSession()],
    avgCalmNormalized: calm, avgAllNormalized: null,
  })
  assertEquals(r.avgCalmNormalized, calm)
  assertEquals(r.avgAllNormalized, null)
})

Deno.test('normalized baselines: both omitted → both null', () => {
  const r = buildTrendsReport({
    period: 30, calmOnly: false, now, sessions: [makeSession()],
  })
  assertEquals(r.avgCalmNormalized, null)
  assertEquals(r.avgAllNormalized, null)
})

Deno.test('calmOnly: filters out tech-issues sessions from sessions[] too', () => {
  const sessions = [
    makeSession({ id: 'clean' }),
    makeSession({ id: 'noisy', signal_quality_pct: 70, auto_tags: ['технические проблемы'] }),
    makeSession({ id: 'shifted', signal_shift_severity: 'high' }),
  ]
  const all = buildTrendsReport({ period: 30, calmOnly: false, now, sessions })
  assertEquals(all.sessions.length, 3)

  const clean = buildTrendsReport({ period: 30, calmOnly: true, now, sessions })
  assertEquals(clean.sessions.length, 1)
  assertEquals(clean.sessions[0].id, 'clean')
})
