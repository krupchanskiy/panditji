/* Tests for computeAutoTags — rule-by-rule.
 * Run: deno test --allow-read tests/meditation/tags.test.ts */

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { computeAutoTags } from '../../supabase/functions/compute-meditation-circles/tags.ts'
import type { SessionForTags } from '../../supabase/functions/compute-meditation-circles/tags.ts'
import type { CircleAgg } from '../../supabase/functions/compute-meditation-circles/compute.ts'

const baseSession: SessionForTags = {
  signalShiftSeverity: null,
  deepeningReliable: true,
  deepeningPct: 30,
  thetaFirstThird: 15,
  thetaLastThird: 18,
  deltaFirstThird: 8,
  deltaLastThird: 8,
  hrFirstThird: 70,
  hrLastThird: 70,
  signalQualityPct: 99,
  headbandOnPct: 99,
  durationCategory: 'standard',
}

function makeCircle(i: number, overrides: Partial<CircleAgg> = {}): CircleAgg {
  return {
    circle_num: i,
    t_start_sec: (i - 1) * 225,
    t_end_sec: i * 225,
    alpha_rel: 30,
    theta_rel: 15,
    beta_rel: 12,
    gamma_rel: 13,
    delta_rel: 8,
    ab_index: 2.5,
    tb_index: 1.25,
    signal_pct: 99,
    ...overrides,
  }
}

const flatCircles: CircleAgg[] = Array.from({ length: 16 }, (_, i) => makeCircle(i + 1))

Deno.test('healthy session with moderate deepening → no negative tags', () => {
  const tags = computeAutoTags(baseSession, flatCircles)
  // 'ровная первая половина' will fire because alpha is dead-flat in the stub.
  assert(tags.includes('ровная первая половина'))
  assert(!tags.includes('артефакт повязки'))
  assert(!tags.includes('недостоверное углубление'))
  assert(!tags.includes('признаки сонливости'))
  assert(!tags.includes('технические проблемы'))
})

Deno.test('signal_shift=high → "артефакт повязки" + "недостоверное углубление"', () => {
  const tags = computeAutoTags(
    { ...baseSession, signalShiftSeverity: 'high', deepeningReliable: false, deepeningPct: 345 },
    flatCircles,
  )
  assert(tags.includes('артефакт повязки'))
  assert(tags.includes('недостоверное углубление'))
  // Strong deepening tag must NOT fire — gate is reliable=true.
  assert(!tags.includes('глубокое углубление'))
})

Deno.test('signal_shift=medium → "смена сигнала", not "артефакт повязки"', () => {
  const tags = computeAutoTags(
    { ...baseSession, signalShiftSeverity: 'medium', deepeningReliable: false },
    flatCircles,
  )
  assert(tags.includes('смена сигнала'))
  assert(!tags.includes('артефакт повязки'))
})

Deno.test('deepening > 70 + reliable → "глубокое углубление"', () => {
  const tags = computeAutoTags({ ...baseSession, deepeningPct: 75 }, flatCircles)
  assert(tags.includes('глубокое углубление'))
  assert(!tags.includes('ровная сессия'))
})

Deno.test('deepening ~0 + reliable → "ровная сессия"', () => {
  const tags = computeAutoTags({ ...baseSession, deepeningPct: 3 }, flatCircles)
  assert(tags.includes('ровная сессия'))
})

Deno.test('deepening < -10 + reliable → "обратная динамика"', () => {
  const tags = computeAutoTags({ ...baseSession, deepeningPct: -20 }, flatCircles)
  assert(tags.includes('обратная динамика'))
})

Deno.test('early theta rise: Theta ≥1.3× at circle 5 → "раннее углубление"', () => {
  const circles: CircleAgg[] = Array.from({ length: 16 }, (_, i) =>
    makeCircle(i + 1, { theta_rel: i >= 4 ? 20 : 14 }),   // jumps at circle 5 (index 4)
  )
  const tags = computeAutoTags(
    { ...baseSession, deepeningPct: 50, deepeningReliable: true },
    circles,
  )
  assert(tags.includes('раннее углубление'))
})

Deno.test('early theta rise NOT fired if jump comes after circle 8', () => {
  const circles: CircleAgg[] = Array.from({ length: 16 }, (_, i) =>
    makeCircle(i + 1, { theta_rel: i >= 9 ? 20 : 14 }),  // jumps at circle 10
  )
  const tags = computeAutoTags({ ...baseSession, deepeningPct: 50 }, circles)
  assert(!tags.includes('раннее углубление'))
})

Deno.test('drowsiness: Theta↑ + Delta↑ + HR↓ → "признаки сонливости"', () => {
  const tags = computeAutoTags({
    ...baseSession,
    thetaFirstThird: 12, thetaLastThird: 20,    // +66%
    deltaFirstThird: 6, deltaLastThird: 9,      // +50%
    hrFirstThird: 72, hrLastThird: 65,          // -10%
  }, flatCircles)
  assert(tags.includes('признаки сонливости'))
})

Deno.test('drowsiness suppressed by signal-shift artefact', () => {
  // Same physiology as the drowsiness case, but headband shifted → must not fire.
  const tags = computeAutoTags({
    ...baseSession,
    signalShiftSeverity: 'high',
    deepeningReliable: false,
    thetaFirstThird: 12, thetaLastThird: 20,
    deltaFirstThird: 6, deltaLastThird: 9,
    hrFirstThird: 72, hrLastThird: 65,
  }, flatCircles)
  assert(!tags.includes('признаки сонливости'))
})

Deno.test('mind wandering: avg Beta in first third > 25 → "много блуждания"', () => {
  const circles: CircleAgg[] = Array.from({ length: 16 }, (_, i) =>
    makeCircle(i + 1, { beta_rel: i < 5 ? 30 : 12 }),
  )
  const tags = computeAutoTags(baseSession, circles)
  assert(tags.includes('много блуждания'))
})

Deno.test('signal_quality < 70 → "технические проблемы" (not also "шумная запись")', () => {
  const tags = computeAutoTags({ ...baseSession, signalQualityPct: 60 }, flatCircles)
  assert(tags.includes('технические проблемы'))
  assert(!tags.includes('шумная запись'))
})

Deno.test('signal_quality 70-90 → "шумная запись"', () => {
  const tags = computeAutoTags({ ...baseSession, signalQualityPct: 82 }, flatCircles)
  assert(tags.includes('шумная запись'))
  assert(!tags.includes('технические проблемы'))
})

Deno.test('headband 85% → "повязка отваливалась" (not "плохо сидела")', () => {
  const tags = computeAutoTags({ ...baseSession, headbandOnPct: 85 }, flatCircles)
  assert(tags.includes('повязка отваливалась'))
  assert(!tags.includes('повязка плохо сидела'))
})

Deno.test('headband 70% → "повязка плохо сидела"', () => {
  const tags = computeAutoTags({ ...baseSession, headbandOnPct: 70 }, flatCircles)
  assert(tags.includes('повязка плохо сидела'))
  assert(!tags.includes('повязка отваливалась'))
})

Deno.test('duration category short / long → corresponding tag', () => {
  const tShort = computeAutoTags({ ...baseSession, durationCategory: 'short' }, flatCircles)
  assertEquals(tShort.includes('короче обычной'), true)
  const tLong = computeAutoTags({ ...baseSession, durationCategory: 'long' }, flatCircles)
  assertEquals(tLong.includes('длиннее обычной'), true)
})
