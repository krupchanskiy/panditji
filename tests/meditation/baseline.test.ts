/* Tests for normalizeToBins, computeBaseline, resampleFromBins.
 * Run: deno test --allow-read tests/meditation/baseline.test.ts */

import { assert, assertEquals, assertAlmostEquals } from 'jsr:@std/assert@1'
import {
  computeBaseline, normalizeToBins, BIN_COUNT, BASELINE_MIN_SESSIONS,
  SessionForBaseline,
} from '../../supabase/functions/recompute-meditation-baseline/baseline.ts'
import { resampleFromBins } from '../../supabase/functions/recompute-meditation-baseline/resample.ts'

function makeSession(overrides: Partial<SessionForBaseline> = {}): SessionForBaseline {
  const circles = 16
  return {
    id: 's-' + Math.random().toString(36).slice(2, 8),
    duration_sec: 3600,
    circles,
    signal_quality_pct: 99,
    signal_shift_severity: null,
    deepening_reliable: true,
    deepening_pct: 50,
    ab_index_median: 3.0,
    beta_median_rel: 15,
    longest_calm_sec: 600,
    calm_periods_count: 4,
    duration_category: 'standard',
    auto_tags: [],
    excluded_from_stats: false,
    per_circle: {
      alpha: Array.from({ length: circles }, () => 30),
      theta: Array.from({ length: circles }, () => 15),
      beta:  Array.from({ length: circles }, () => 12),
      ab:    Array.from({ length: circles }, () => 2.5),
    },
    ...overrides,
  }
}

/* ── normalizeToBins ───────────────────────────────────────────────────── */

Deno.test('normalizeToBins: N=16 → identity (each bin = its own circle)', () => {
  const vals = Array.from({ length: 16 }, (_, i) => i + 1)   // [1..16]
  const bins = normalizeToBins(vals)
  assertEquals(bins.length, 16)
  assertEquals(bins, vals)
})

Deno.test('normalizeToBins: N=8 → each bin gets one of the two adjacent circles', () => {
  const vals = [10, 20, 30, 40, 50, 60, 70, 80]
  const bins = normalizeToBins(vals)
  assertEquals(bins.length, 16)
  // First two bins (positions 0/16 and 1/16) both map to circle 0 → 10.
  assertEquals(bins[0], 10)
  assertEquals(bins[1], 10)
  // Last bins map to circle 7 → 80.
  assertEquals(bins[14], 80)
  assertEquals(bins[15], 80)
  // Mean across all 16 bins should equal mean of source values (8 circles, each shown twice).
  const m = bins.reduce((a, b) => a + b, 0) / 16
  assertAlmostEquals(m, 45, 0.01)
})

Deno.test('normalizeToBins: N=32 → each bin averages 2 circles', () => {
  const vals = Array.from({ length: 32 }, (_, i) => i * 2 + 1)   // [1,3,5..63]
  const bins = normalizeToBins(vals)
  assertEquals(bins.length, 16)
  // Bin 0 spans indices [0, 2): mean(1, 3) = 2
  assertEquals(bins[0], 2)
  // Bin 8 spans indices [16, 18): mean(33, 35) = 34
  assertEquals(bins[8], 34)
})

Deno.test('normalizeToBins: empty array → 16 NaN', () => {
  const bins = normalizeToBins([])
  assertEquals(bins.length, 16)
  for (const v of bins) assert(Number.isNaN(v))
})

/* ── computeBaseline ───────────────────────────────────────────────────── */

Deno.test('computeBaseline: empty → session_count=0, all averages null', () => {
  const b = computeBaseline([], false)
  assertEquals(b.session_count, 0)
  assertEquals(b.avg_deepening, null)
  assertEquals(b.avg_alpha_normalized, null)
})

Deno.test('computeBaseline: under MIN_SESSIONS → averages null but count reported', () => {
  const sessions = Array.from({ length: BASELINE_MIN_SESSIONS - 1 }, () => makeSession())
  const b = computeBaseline(sessions, false)
  assertEquals(b.session_count, BASELINE_MIN_SESSIONS - 1)
  assertEquals(b.avg_deepening, null)
  assertEquals(b.avg_theta_normalized, null)
})

Deno.test('computeBaseline: 5+ identical sessions → averages equal the session values', () => {
  const sessions = Array.from({ length: 6 }, () => makeSession({
    deepening_pct: 40, ab_index_median: 2.8, beta_median_rel: 14,
    longest_calm_sec: 540, calm_periods_count: 3,
  }))
  const b = computeBaseline(sessions, false)
  assertEquals(b.session_count, 6)
  assertEquals(b.avg_deepening, 40)
  assertEquals(b.avg_stability, 2.8)
  assertEquals(b.avg_beta, 14)
  assertEquals(b.avg_longest_calm_sec, 540)
  assertEquals(b.avg_calm_periods_count, 3)
  // All per-circle bins equal the constant.
  assertEquals(b.avg_alpha_normalized![0], 30)
  assertEquals(b.avg_alpha_normalized![15], 30)
  assertEquals(b.avg_alpha_normalized!.length, BIN_COUNT)
})

Deno.test('computeBaseline: filters non-aggregate sessions out', () => {
  const ok = Array.from({ length: 6 }, () => makeSession({ deepening_pct: 50 }))
  const excluded = makeSession({ deepening_pct: 999, excluded_from_stats: true })
  const short = makeSession({ deepening_pct: 999, duration_category: 'short' })
  const noCircles = makeSession({ circles: null, per_circle: { alpha: [], theta: [], beta: [], ab: [] } })

  const b = computeBaseline([...ok, excluded, short, noCircles], false)
  assertEquals(b.session_count, 6)
  assertEquals(b.avg_deepening, 50)   // outliers excluded
})

Deno.test('computeBaseline: calmOnly applies tech-quality filter only', () => {
  const calm = Array.from({ length: 5 }, () => makeSession({ deepening_pct: 50 }))
  const noisy = makeSession({ deepening_pct: 999, signal_quality_pct: 70 })
  const shifted = makeSession({ deepening_pct: 999, signal_shift_severity: 'high' })

  const all = computeBaseline([...calm, noisy, shifted], false)
  assertEquals(all.session_count, 7)
  const clean = computeBaseline([...calm, noisy, shifted], true)
  assertEquals(clean.session_count, 5)
  // Note: calmOnly checks only technical quality — self_rating/distracted aren't
  // even fields on SessionForBaseline. That circular-reasoning guard is enforced
  // structurally at the type level + tested explicitly in trends.test.ts (isCalm).
})

Deno.test('computeBaseline: deepening skips unreliable values regardless of calmOnly', () => {
  const reliable = Array.from({ length: 5 }, () => makeSession({ deepening_pct: 50 }))
  const broken = makeSession({
    deepening_pct: 999, deepening_reliable: false,
  })
  // calmOnly=false → broken counts in session_count but not in avg_deepening.
  const b = computeBaseline([...reliable, broken], false)
  assertEquals(b.session_count, 6)
  assertEquals(b.avg_deepening, 50)   // 999 dropped via deepening_reliable check
})

Deno.test('computeBaseline: per-circle bins average across heterogeneous circle counts', () => {
  // 6 sessions, half with 12 circles, half with 24 circles. Alpha = position+constant.
  const sessions: SessionForBaseline[] = []
  for (let k = 0; k < 3; k++) {
    sessions.push(makeSession({
      circles: 12,
      per_circle: {
        alpha: Array.from({ length: 12 }, (_, i) => 20 + i),
        theta: Array.from({ length: 12 }, () => 10),
        beta:  Array.from({ length: 12 }, () => 10),
        ab:    Array.from({ length: 12 }, () => 1),
      },
    }))
  }
  for (let k = 0; k < 3; k++) {
    sessions.push(makeSession({
      circles: 24,
      per_circle: {
        alpha: Array.from({ length: 24 }, (_, i) => 20 + i / 2),
        theta: Array.from({ length: 24 }, () => 10),
        beta:  Array.from({ length: 24 }, () => 10),
        ab:    Array.from({ length: 24 }, () => 1),
      },
    }))
  }
  const b = computeBaseline(sessions, false)
  assert(b.avg_alpha_normalized !== null)
  // Bin 0 (start of session) ≈ 20; bin 15 (end) ≈ much higher. Monotonic.
  assert(b.avg_alpha_normalized![0] < b.avg_alpha_normalized![15],
    `expected alpha bins monotonic, got ${b.avg_alpha_normalized!.join(', ')}`)
})

/* ── resampleFromBins ──────────────────────────────────────────────────── */

Deno.test('resampleFromBins: target=16 → near-identity (centre alignment)', () => {
  const bins = Array.from({ length: 16 }, (_, i) => i * 10)   // [0,10,20..150]
  const out = resampleFromBins(bins, 16)
  // Endpoints clamp; interior should be very close to input.
  assertEquals(out.length, 16)
  assertEquals(out[0], 0)
  assertEquals(out[15], 150)
  for (let i = 1; i < 15; i++) {
    assertAlmostEquals(out[i], bins[i], 0.01)
  }
})

Deno.test('resampleFromBins: target=8 → 8 interpolated values, monotonic', () => {
  const bins = Array.from({ length: 16 }, (_, i) => i * 10)
  const out = resampleFromBins(bins, 8)
  assertEquals(out.length, 8)
  // Monotonic in lock-step with input.
  for (let i = 1; i < out.length; i++) {
    assert(out[i] > out[i - 1])
  }
})

Deno.test('resampleFromBins: target=24 → interpolation fills between bins', () => {
  const bins = Array.from({ length: 16 }, (_, i) => i * 10)
  const out = resampleFromBins(bins, 24)
  assertEquals(out.length, 24)
  // Range matches input range.
  assert(out[0] >= 0 && out[0] <= 10)
  assert(out[23] >= 140 && out[23] <= 150)
})

Deno.test('resampleFromBins: constant baseline → constant output', () => {
  const bins = new Array(16).fill(42)
  for (const n of [8, 16, 24]) {
    const out = resampleFromBins(bins, n)
    for (const v of out) assertEquals(v, 42)
  }
})

Deno.test('resampleFromBins: target=0 → empty', () => {
  assertEquals(resampleFromBins(new Array(16).fill(1), 0), [])
})
