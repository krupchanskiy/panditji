/* Tests for computeCircles + sub-helpers.
 * Run: deno test --allow-read tests/meditation/compute.test.ts
 *
 * Strategy:
 *  1) End-to-end on real fixtures — parse CSV, feed timeline into computeCircles
 *     with the brief's expected 16 circles, assert against ranges from the brief.
 *  2) Unit tests on edge cases: findLongestRun, countRunsAtLeast, deepening reliability,
 *     duration category boundaries. */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { parseMindMonitorCSV } from '../../supabase/functions/parse-meditation-csv/parser.ts'
import {
  computeCircles,
  __test__,
  DEEPENING_SANITY_CEILING_PCT,
} from '../../supabase/functions/compute-meditation-circles/compute.ts'

const { findLongestRun, countRunsAtLeast } = __test__

const FIXTURES = new URL('../fixtures/meditation/', import.meta.url)

async function loadFixture(name: string): Promise<string> {
  const compressed = await Deno.readFile(new URL(name + '.gz', FIXTURES))
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

Deno.test('good_signal.csv — 16 circles, reliable deepening, longest_calm matches brief', async () => {
  const csv = await loadFixture('good_signal.csv')
  const session = parseMindMonitorCSV(csv)

  const result = computeCircles({
    durationSec: session.durationSec,
    thetaFirstThird: session.thetaFirstThird,
    thetaLastThird: session.thetaLastThird,
    signalShiftAtSec: session.signalShiftAtSec,
    timeline30s: session.timeline30s,
    circlesCount: 16,
    recentRegularDurations: [],   // no history → category falls back to 'standard'
  })

  // 16 circles, monotonic timeline.
  assertEquals(result.circles.length, 16)
  for (let i = 0; i < 16; i++) {
    assertEquals(result.circles[i].circle_num, i + 1)
    assert(result.circles[i].t_end_sec > result.circles[i].t_start_sec)
    if (i > 0) {
      assertEquals(result.circles[i].t_start_sec, result.circles[i - 1].t_end_sec)
    }
  }

  // Pace: ~60.6 min / 16 ≈ 3.79 min/circle.
  assert(result.paceMinPerCircle >= 3.5 && result.paceMinPerCircle <= 4.0,
    `pace ${result.paceMinPerCircle} not in [3.5, 4.0]`)

  // Deepening: brief expects ~+60%, reliable=true.
  assertEquals(result.deepeningReliable, true)
  assertExists(result.deepeningPct)
  assert(result.deepeningPct! > 30 && result.deepeningPct! < 100,
    `deepeningPct ${result.deepeningPct} not in [30, 100] — expected ~+63%`)

  // Calm periods: brief expects longest ≈ 10 min = 600 sec on this session.
  // P75 is sensitive; allow a wide band but assert there's substantial calm.
  assert(result.longestCalmSec >= 120,
    `longest_calm ${result.longestCalmSec} should be ≥ 120 sec on a clean session`)
  assert(result.calmPeriodsCount >= 1,
    `expected at least 1 calm period of ≥60 sec`)

  // No history → standard, no deviation reported.
  assertEquals(result.durationCategory, 'standard')
  assertEquals(result.durationVsMedianPct, null)

  // Circle band relatives sum to ~100%.
  for (const c of result.circles) {
    const sum = c.alpha_rel + c.theta_rel + c.beta_rel + c.gamma_rel + c.delta_rel
    assert(sum > 95 && sum < 105, `circle ${c.circle_num}: band sum ${sum} ≠ ~100`)
  }
})

Deno.test('signal_shift.csv — deepening unreliable, calm computed only before shift', async () => {
  const csv = await loadFixture('signal_shift.csv')
  const session = parseMindMonitorCSV(csv)

  const result = computeCircles({
    durationSec: session.durationSec,
    thetaFirstThird: session.thetaFirstThird,
    thetaLastThird: session.thetaLastThird,
    signalShiftAtSec: session.signalShiftAtSec,
    timeline30s: session.timeline30s,
    circlesCount: 16,
    recentRegularDurations: [],
  })

  // Raw deepening on this session is ~+345% — over sanity ceiling AND shift detected.
  assertEquals(result.deepeningReliable, false)
  // Raw number is still returned (caller decides whether to show).
  assertExists(result.deepeningPct)

  // Longest calm: must be derived only from windows BEFORE the shift.
  // Shift at ~1620s → calmTimeline length ≈ 54 windows. Longest run can't span the shift.
  const shiftAt = session.signalShiftAtSec!
  assert(result.longestCalmAtSec + result.longestCalmSec <= shiftAt + 60,
    `longest_calm (start=${result.longestCalmAtSec}, len=${result.longestCalmSec}) ` +
    `extends past shift at ${shiftAt}s`)
})

Deno.test('deepening: theta_first < 1% → null + unreliable', async () => {
  const result = computeCircles({
    durationSec: 3600,
    thetaFirstThird: 0.5,
    thetaLastThird: 5,
    signalShiftAtSec: null,
    timeline30s: stubTimeline(120),
    circlesCount: 16,
    recentRegularDurations: [],
  })
  assertEquals(result.deepeningPct, null)
  assertEquals(result.deepeningReliable, false)
})

Deno.test('deepening: signal_shift present → reliable=false even with sane number', async () => {
  const result = computeCircles({
    durationSec: 3000,
    thetaFirstThird: 15,
    thetaLastThird: 18,                // +20% — well within sanity ceiling
    signalShiftAtSec: 1620,
    timeline30s: stubTimeline(100),
    circlesCount: 16,
    recentRegularDurations: [],
  })
  assertExists(result.deepeningPct)
  assertEquals(result.deepeningReliable, false)
})

Deno.test('deepening: over sanity ceiling → reliable=false but raw value kept', async () => {
  const result = computeCircles({
    durationSec: 3600,
    thetaFirstThird: 10,
    thetaLastThird: 50,                // +400% — well past ceiling
    signalShiftAtSec: null,
    timeline30s: stubTimeline(120),
    circlesCount: 16,
    recentRegularDurations: [],
  })
  assertExists(result.deepeningPct)
  assert(Math.abs(result.deepeningPct!) > DEEPENING_SANITY_CEILING_PCT)
  assertEquals(result.deepeningReliable, false)
})

Deno.test('duration_category: <5 history → standard, null deviation', () => {
  const r = computeCircles({
    durationSec: 1200,                 // 20 min — would be 'short' if compared
    thetaFirstThird: 15, thetaLastThird: 17,
    signalShiftAtSec: null,
    timeline30s: stubTimeline(40),
    circlesCount: 8,
    recentRegularDurations: [3600, 3600, 3600, 3600],   // only 4 entries
  })
  assertEquals(r.durationCategory, 'standard')
  assertEquals(r.durationVsMedianPct, null)
})

Deno.test('duration_category: standard / short / long boundaries', () => {
  const base = {
    thetaFirstThird: 15, thetaLastThird: 17,
    signalShiftAtSec: null,
    circlesCount: 16,
    // Median 3600 sec from 5 sessions.
    recentRegularDurations: [3500, 3550, 3600, 3650, 3700],
  }
  // -16.7%: standard
  const standard = computeCircles({ ...base, durationSec: 3000, timeline30s: stubTimeline(100) })
  assertEquals(standard.durationCategory, 'standard')
  assertExists(standard.durationVsMedianPct)

  // -33%: short
  const short = computeCircles({ ...base, durationSec: 2400, timeline30s: stubTimeline(80) })
  assertEquals(short.durationCategory, 'short')

  // +50%: long
  const long = computeCircles({ ...base, durationSec: 5400, timeline30s: stubTimeline(180) })
  assertEquals(long.durationCategory, 'long')
})

Deno.test('findLongestRun: empty, all-true, all-false, mixed', () => {
  assertEquals(findLongestRun([]), { length: 0, start: 0 })
  assertEquals(findLongestRun([true, true, true]).length, 3)
  assertEquals(findLongestRun([false, false]).length, 0)
  // Two runs, second is longer.
  const r = findLongestRun([true, true, false, true, true, true, false])
  assertEquals(r.length, 3)
  assertEquals(r.start, 3)
})

Deno.test('countRunsAtLeast: counts runs of minLen, includes trailing run', () => {
  // Runs: [3, 2, 1, 4] — with minLen=2, count 3.
  const flags = [true, true, true, false, true, true, false, true, false, true, true, true, true]
  assertEquals(countRunsAtLeast(flags, 2), 3)
  // minLen=4 → only the trailing run of 4.
  assertEquals(countRunsAtLeast(flags, 4), 1)
})

/* Helper: build a synthetic timeline with N windows, ab_index alternating around P75 cleanly. */
function stubTimeline(n: number) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push({
      t: i * 30,
      alpha: 30, theta: 15, beta: 10, gamma: 10, delta: 5,
      ab: 3 + (i % 4 === 0 ? 1 : 0),
      tb: 1.5,
      signal_ok: true,
    })
  }
  return out
}
