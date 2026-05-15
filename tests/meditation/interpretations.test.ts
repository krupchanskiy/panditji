/* Tests for interpretation templates + phase detector.
 *
 * Two responsibilities:
 *   1. Each template branch produces the expected text shape.
 *   2. NO generated text contains forbidden words/emoji — assertNoForbidden
 *      already throws inside the generators, so we just exercise every branch
 *      and the lint runs implicitly. We also add explicit lint tests for the helper.
 *
 * Run: deno test --allow-read tests/meditation/interpretations.test.ts */

import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import {
  generateMainCaption, generateCalmCaption, assertNoForbidden,
  SessionForInterpretation, INTERPRETATION_VERSION,
} from '../../supabase/functions/compute-meditation-circles/interpretations.ts'
import { detectPhases } from '../../supabase/functions/compute-meditation-circles/phases.ts'
import type { CircleAgg } from '../../supabase/functions/compute-meditation-circles/compute.ts'

const baseSession: SessionForInterpretation = {
  signalShiftSeverity: null,
  signalShiftAtSec: null,
  deepeningReliable: true,
  deepeningPct: 30,
  thetaFirstThird: 15,
  thetaLastThird: 19,
  alphaFirstThird: 40,
  alphaLastThird: 38,
  alphaMedianRel: 40,
  autoTags: [],
}

function makeCircle(i: number, overrides: Partial<CircleAgg> = {}): CircleAgg {
  return {
    circle_num: i, t_start_sec: (i - 1) * 225, t_end_sec: i * 225,
    alpha_rel: 30, theta_rel: 15, beta_rel: 12, gamma_rel: 13, delta_rel: 8,
    ab_index: 2.5, tb_index: 1.25, signal_pct: 99, ...overrides,
  }
}
const flatCircles = Array.from({ length: 16 }, (_, i) => makeCircle(i + 1))

Deno.test('INTERPRETATION_VERSION is v1', () => {
  assertEquals(INTERPRETATION_VERSION, 'v1')
})

/* ── main caption branches ──────────────────────────────────────────────── */

Deno.test('main: signal_shift=high → mentions the minute and shift', () => {
  const text = generateMainCaption({
    ...baseSession, signalShiftSeverity: 'high', signalShiftAtSec: 1620,
    deepeningReliable: false,
  }, flatCircles)
  assert(text.includes('27-й минуте'))
  assert(text.includes('повязка'))
  assert(text.includes('недостоверны'))
})

Deno.test('main: signal_shift=medium → softer wording, no "недостоверны"', () => {
  const text = generateMainCaption({
    ...baseSession, signalShiftSeverity: 'medium', signalShiftAtSec: 900,
    deepeningReliable: false,
  }, flatCircles)
  assert(text.includes('15-й минуте'))
  assert(text.includes('ступенька'))
})

Deno.test('main: drowsiness tag → "дрёма" wording', () => {
  const text = generateMainCaption({
    ...baseSession, autoTags: ['признаки сонливости'],
  }, flatCircles)
  assert(text.includes('дрём'))
  assert(text.includes('Theta'))
})

Deno.test('main: regression (deepening < -15) → "снижается", suggests checking signal', () => {
  const text = generateMainCaption({
    ...baseSession, deepeningPct: -25,
  }, flatCircles)
  assert(text.includes('снижается'))
  assert(text.includes('сигнал'))
})

Deno.test('main: strong deepening (>40, reliable) → mentions dharana→dhyana', () => {
  const circles = Array.from({ length: 16 }, (_, i) =>
    makeCircle(i + 1, { theta_rel: i >= 6 ? 25 : 15 }),
  )
  const text = generateMainCaption({
    ...baseSession, deepeningPct: 67, thetaLastThird: 25,
  }, circles)
  assert(text.includes('Углубление'))
  assert(text.includes('dharana') && text.includes('dhyana'))
  assert(text.includes('16-му кругу'))
})

Deno.test('main: flat session (|Δ|<15, reliable) → "ровная", quotes Alpha', () => {
  const text = generateMainCaption({
    ...baseSession, deepeningPct: 5,
  }, flatCircles)
  assert(text.includes('ровная'))
  assert(text.includes('Alpha'))
})

Deno.test('main: moderate deepening (reliable, in between) → minimal phrasing', () => {
  const text = generateMainCaption({
    ...baseSession, deepeningPct: 25, thetaLastThird: 19,
  }, flatCircles)
  assert(text.includes('Умеренное углубление'))
  assert(text.includes('15%') && text.includes('19%'))
})

Deno.test('main: fallback for unreliable deepening with no shift', () => {
  const text = generateMainCaption({
    ...baseSession, deepeningReliable: false, deepeningPct: 300,
    signalShiftSeverity: null,
  }, flatCircles)
  assert(text.includes('Сессия записана'))
  assert(text.includes('график'))
})

/* ── calm caption ───────────────────────────────────────────────────────── */

Deno.test('calm: longest=632s on 8th circle of 3.79min/circle → matches brief shape', () => {
  // (longestAt 1620 / 60) / 3.79 = 7.12 → floor + 1 = 8
  const text = generateCalmCaption(632, 1620, 3.79)
  assert(text !== null)
  assert(text!.includes('10 мин 32 сек'))
  assert(text!.includes('8-м круге'))
})

Deno.test('calm: exact minutes drops "сек"', () => {
  const text = generateCalmCaption(600, 1800, 3.79)
  assert(text!.includes('10 мин,'))
  assert(!text!.includes('сек,'))
})

Deno.test('calm: zero seconds → null', () => {
  assertEquals(generateCalmCaption(0, 0, 3.79), null)
})

/* ── lint helper ────────────────────────────────────────────────────────── */

Deno.test('assertNoForbidden: throws on each banned phrase', () => {
  for (const phrase of ['идеально', 'молодец', 'продолжай в том же духе', 'к сожалению']) {
    assertThrows(
      () => assertNoForbidden(`Сегодня было ${phrase} получилось.`, 'test'),
      Error, '[interpretation lint]',
    )
  }
})

Deno.test('assertNoForbidden: throws on emoji', () => {
  assertThrows(() => assertNoForbidden('Отличная сессия 🎉', 'test'), Error, 'emoji')
  assertThrows(() => assertNoForbidden('✨ Глубокое углубление', 'test'), Error, 'emoji')
})

Deno.test('assertNoForbidden: passes neutral text', () => {
  assertNoForbidden('Theta выросла с 15% до 22% — заметный сдвиг к концу.', 'test')
})

/* ── phases ──────────────────────────────────────────────────────────── */

Deno.test('phases: flat session → single Плато spanning all circles', () => {
  const phases = detectPhases(baseSession, flatCircles)
  assertEquals(phases.length, 1)
  assertEquals(phases[0].label, 'Плато')
  assertEquals(phases[0].range, [1, 16])
})

Deno.test('phases: slow opening + deepening → Вход / Плато / Углубление', () => {
  const circles = Array.from({ length: 16 }, (_, i) => makeCircle(i + 1, {
    alpha_rel: i < 2 ? 30 : 40,
    theta_rel: i >= 8 ? 22 : 15,
  }))
  const phases = detectPhases({
    ...baseSession, alphaMedianRel: 40, deepeningPct: 50, thetaLastThird: 22,
  }, circles)
  const labels = phases.map(p => p.label)
  assert(labels.includes('Вход'))
  assert(labels.includes('Плато'))
  assert(labels.includes('Углубление'))
})

Deno.test('phases: drowsiness wins over deepening when both are present', () => {
  const circles = Array.from({ length: 16 }, (_, i) => makeCircle(i + 1, {
    theta_rel: i >= 8 ? 22 : 14,
  }))
  const phases = detectPhases({
    ...baseSession, autoTags: ['признаки сонливости'], deepeningPct: 55, thetaLastThird: 22,
  }, circles)
  assert(phases.some(p => p.label === 'Сонливость'))
  assert(!phases.some(p => p.label === 'Углубление'))
})

Deno.test('phases: re-entry produces independent arrays (no module-state leak)', () => {
  const first = detectPhases(baseSession, flatCircles)
  const second = detectPhases(baseSession, flatCircles)
  assertEquals(first.length, second.length)
  assertEquals(first[0].range, second[0].range)
})

Deno.test('phases: all generated notes pass the lint (no forbidden words)', () => {
  const cases: { s: SessionForInterpretation; c: CircleAgg[] }[] = [
    { s: baseSession, c: flatCircles },
    { s: { ...baseSession, deepeningPct: 70, thetaLastThird: 25 }, c: flatCircles },
    {
      s: { ...baseSession, autoTags: ['признаки сонливости'], thetaLastThird: 22 },
      c: Array.from({ length: 16 }, (_, i) => makeCircle(i + 1, { theta_rel: i >= 8 ? 22 : 14 })),
    },
  ]
  for (const { s, c } of cases) {
    const phases = detectPhases(s, c)
    for (const p of phases) assertNoForbidden(p.note, `phase[${p.label}]`)
  }
})
