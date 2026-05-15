/* Tests for spearman / rankWithTies / pearson / interpretCorrelation / computeCorrelations.
 * Run: deno test --allow-read tests/meditation/correlations.test.ts */

import { assert, assertAlmostEquals, assertEquals } from 'jsr:@std/assert@1'
import {
  spearman, rankWithTies, pearson, interpretCorrelation, computeCorrelations,
  CORRELATION_MIN_N, CORRELATION_SIGNIFICANT_MIN_N,
} from '../../supabase/functions/get-trends-report/correlations.ts'
import type { SessionForTrends } from '../../supabase/functions/get-trends-report/trends.ts'

/* ── rankWithTies ──────────────────────────────────────────────────────── */

Deno.test('rankWithTies: no ties → 1..N', () => {
  assertEquals(rankWithTies([10, 20, 30]), [1, 2, 3])
  assertEquals(rankWithTies([30, 10, 20]), [3, 1, 2])
})

Deno.test('rankWithTies: with ties → average rank', () => {
  // [3, 1, 3, 2] sorted = [(1,1), (2,3), (3,0), (3,2)] → ranks at positions 0:3.5, 1:1, 2:3.5, 3:2.
  assertEquals(rankWithTies([3, 1, 3, 2]), [3.5, 1, 3.5, 2])
  // All ties → all rank 2 (mean of 1,2,3).
  assertEquals(rankWithTies([5, 5, 5]), [2, 2, 2])
})

/* ── pearson ───────────────────────────────────────────────────────────── */

Deno.test('pearson: perfect positive → 1, perfect negative → -1', () => {
  assertEquals(pearson([1, 2, 3, 4, 5], [10, 20, 30, 40, 50]), 1)
  assertEquals(pearson([1, 2, 3, 4, 5], [50, 40, 30, 20, 10]), -1)
})

Deno.test('pearson: zero variance → 0 (avoids NaN)', () => {
  assertEquals(pearson([1, 2, 3], [5, 5, 5]), 0)
  assertEquals(pearson([5, 5, 5], [1, 2, 3]), 0)
})

/* ── spearman ──────────────────────────────────────────────────────────── */

Deno.test('spearman: monotonic positive non-linear → r=1 (rank-based)', () => {
  // y = x^3 is strictly increasing → Spearman 1 (Pearson would be ~0.94).
  const r = spearman([1, 2, 3, 4, 5], [1, 8, 27, 64, 125])
  assertEquals(r, 1)
})

Deno.test('spearman: monotonic negative non-linear → r=-1', () => {
  const r = spearman([1, 2, 3, 4, 5], [-1, -8, -27, -64, -125])
  assertEquals(r, -1)
})

Deno.test('spearman: returns null on length mismatch / too few points', () => {
  assertEquals(spearman([1, 2], [3, 4]), null)        // < 3
  assertEquals(spearman([1, 2, 3], [4, 5]), null)     // length mismatch
})

Deno.test('spearman: noisy positive ~0.7 within 0.1', () => {
  // y = x + small noise → high positive Spearman.
  const xs = Array.from({ length: 20 }, (_, i) => i + 1)
  const noisy = xs.map((x, i) => x + (i % 3 === 0 ? -1 : i % 3 === 1 ? 0 : 1))
  const r = spearman(xs, noisy)!
  assert(r > 0.85, `expected r > 0.85, got ${r}`)
})

/* ── interpretCorrelation ──────────────────────────────────────────────── */

Deno.test('interpretCorrelation: bucket boundaries', () => {
  assert(interpretCorrelation(0.1, 20).startsWith('корреляции не обнаружено'))
  assert(interpretCorrelation(0.3, 20).startsWith('слабая положительная'))
  assert(interpretCorrelation(-0.5, 20).startsWith('умеренная отрицательная'))
  assert(interpretCorrelation(0.85, 30).startsWith('сильная положительная'))
})

Deno.test('interpretCorrelation: always includes r and n in tail', () => {
  const t = interpretCorrelation(0.45, 18)
  assert(t.includes('r=0.45'))
  assert(t.includes('n=18'))
})

/* ── computeCorrelations: helpers ──────────────────────────────────────── */

function makeSession(overrides: Partial<SessionForTrends> = {}): SessionForTrends {
  return {
    id: 's-' + Math.random().toString(36).slice(2, 8),
    started_at: '2026-05-15T06:00:00Z',
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

/* Build a sequence of sessions with linear sleep → deepening relationship.
 * sleep 5.0..9.0 (step 0.2), deepening 20..100 (step 4). 20 sessions. */
function makeLinearSleepDeepening(n = 20): SessionForTrends[] {
  return Array.from({ length: n }, (_, i) => makeSession({
    id: 'lin-' + i,
    whoop_sleep_hours: 5 + i * 0.2,
    deepening_pct: 20 + i * 4,
  }))
}

/* ── computeCorrelations ───────────────────────────────────────────────── */

Deno.test('computeCorrelations: sleep→deepening strong positive', () => {
  const sessions = makeLinearSleepDeepening(20)
  const r = computeCorrelations(sessions, false)
  assert(r.sleepVsDeepening.r! > 0.9, `expected r>0.9, got ${r.sleepVsDeepening.r}`)
  assertEquals(r.sleepVsDeepening.n, 20)
  assertEquals(r.sleepVsDeepening.significant, true)
  assert(r.sleepVsDeepening.interpretation.startsWith('сильная положительная'))
})

Deno.test('computeCorrelations: deepening unreliable values dropped from sleep→deepening', () => {
  const ok = makeLinearSleepDeepening(15)
  const broken = Array.from({ length: 5 }, (_, i) => makeSession({
    id: 'broken-' + i,
    deepening_reliable: false, deepening_pct: 999,    // garbage that would destroy r
    whoop_sleep_hours: 7,
  }))
  const r = computeCorrelations([...ok, ...broken], false)
  assertEquals(r.sleepVsDeepening.n, 15)    // broken dropped via deepeningOf gate
})

Deno.test('computeCorrelations: insufficient n → null r, "недостаточно данных"', () => {
  const sessions = makeLinearSleepDeepening(5)
  const r = computeCorrelations(sessions, false)
  assertEquals(r.sleepVsDeepening.r, null)
  assertEquals(r.sleepVsDeepening.significant, false)
  assert(r.sleepVsDeepening.interpretation.includes('недостаточно данных'))
  assert(r.sleepVsDeepening.interpretation.includes(`n=5`))
})

Deno.test('computeCorrelations: significant requires both |r|>0.3 AND n>=14', () => {
  // Strong correlation, n=13 → not significant.
  const small = makeLinearSleepDeepening(13)
  const rSmall = computeCorrelations(small, false)
  assert(rSmall.sleepVsDeepening.r! > 0.9)
  assertEquals(rSmall.sleepVsDeepening.significant, false)
  // Same data with one more → significant.
  const enough = makeLinearSleepDeepening(14)
  const rEnough = computeCorrelations(enough, false)
  assertEquals(rEnough.sleepVsDeepening.significant, true)
})

Deno.test('computeCorrelations: distracted box-plot NOT calm-filtered', () => {
  // 8 "никто" with clean signal, 6 "сильно" with bad signal.
  const calm = Array.from({ length: 8 }, () => makeSession({
    distracted: 'никто', deepening_pct: 60, signal_quality_pct: 99,
  }))
  const noisy = Array.from({ length: 6 }, () => makeSession({
    distracted: 'сильно', deepening_pct: 20,
    signal_quality_pct: 70, auto_tags: ['технические проблемы'],
    // These would normally be filtered by calmOnly — must still appear in box-plot.
  }))
  const r = computeCorrelations([...calm, ...noisy], true)
  const nikto = r.distractedVsDeepening.groups.find(g => g.label === 'никто')!
  const silno = r.distractedVsDeepening.groups.find(g => g.label === 'сильно')!
  assertEquals(nikto.n, 8)
  assertEquals(silno.n, 6)          // not zero — calm filter NOT applied
  assertEquals(nikto.median, 60)
  assertEquals(silno.median, 20)
  assert(r.distractedVsDeepening.interpretation.includes('заметно глубже'))
})

Deno.test('computeCorrelations: box-plot interpretation handles empty group', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => makeSession({
    distracted: 'никто',
    deepening_pct: 50 + i,
  }))
  const r = computeCorrelations(sessions, false)
  const silno = r.distractedVsDeepening.groups.find(g => g.label === 'сильно')!
  assertEquals(silno.n, 0)
  assertEquals(silno.median, null)
  assert(r.distractedVsDeepening.interpretation.includes('недостаточно данных'))
})

Deno.test('computeCorrelations: aggregation filter drops excluded/short/long', () => {
  const eligible = makeLinearSleepDeepening(12)
  const dirty = [
    makeSession({ id: 'ex', excluded_from_stats: true, whoop_sleep_hours: 9, deepening_pct: 100 }),
    makeSession({ id: 'sh', duration_category: 'short', whoop_sleep_hours: 9, deepening_pct: 100 }),
    makeSession({ id: 'nc', circles: null, whoop_sleep_hours: 9, deepening_pct: 100 }),
  ]
  const r = computeCorrelations([...eligible, ...dirty], false)
  assertEquals(r.sleepVsDeepening.n, 12)
})

Deno.test('computeCorrelations: empty input → all "недостаточно данных"', () => {
  const r = computeCorrelations([], false)
  assertEquals(r.sleepVsDeepening.n, 0)
  assertEquals(r.recoveryVsStability.n, 0)
  assertEquals(r.selfRatingVsAb.n, 0)
  assertEquals(r.distractedVsDeepening.groups.length, 3)
  for (const g of r.distractedVsDeepening.groups) assertEquals(g.n, 0)
})

/* ── thresholds exported (sanity check) ──────────────────────────────── */

Deno.test('constants: thresholds match the brief', () => {
  assertEquals(CORRELATION_MIN_N, 10)
  assertEquals(CORRELATION_SIGNIFICANT_MIN_N, 14)
})

/* ── numeric edge: ranking with ties propagates correctly through spearman ── */

Deno.test('spearman: handles ties (e.g. categorical self_rating 1..5)', () => {
  // 10 sessions with self_rating in {2,3,4,5} and AB monotonically rising.
  const ratings = [2, 2, 3, 3, 4, 4, 5, 5, 5, 5]
  const abs = [2.0, 2.1, 2.4, 2.5, 2.7, 2.8, 3.0, 3.1, 3.2, 3.3]
  const r = spearman(ratings, abs)
  assert(r! > 0.9, `expected r>0.9 on monotonic categorical, got ${r}`)
})
