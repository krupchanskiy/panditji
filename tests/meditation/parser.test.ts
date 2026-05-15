/* Unit tests for parseMindMonitorCSV.
 * Run: deno test --allow-read tests/meditation/parser.test.ts
 *
 * Fixtures (real Mind Monitor exports from Adrian's Muse Athena):
 *   good_signal.csv  — clean 60.6-min session, no headband shifts
 *   signal_shift.csv — ~50 min, headband slipped around minute 27
 *
 * Tests assert ranges, not exact values — synthetic data assumptions in TZ are upper-bound. */

import { assert, assertEquals, assertExists } from 'jsr:@std/assert@1'
import { parseMindMonitorCSV, ParseError } from '../../supabase/functions/parse-meditation-csv/parser.ts'

const FIXTURES = new URL('../fixtures/meditation/', import.meta.url)

/* Fixtures are stored gzipped (same format as in Supabase Storage in prod).
 * We decompress via the standard DecompressionStream — no Node-only deps. */
async function loadFixture(name: string): Promise<string> {
  const compressed = await Deno.readFile(new URL(name + '.gz', FIXTURES))
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

Deno.test('good_signal.csv — clean 60-min session', async () => {
  const csv = await loadFixture('good_signal.csv')
  const r = parseMindMonitorCSV(csv)

  // Duration: 06:37:10 → 07:37:48 ≈ 60.6 min (3638 sec).
  assert(r.durationSec >= 3600 && r.durationSec <= 3700,
    `durationSec ${r.durationSec} not in [3600, 3700]`)

  // Headband on throughout.
  assert(r.headbandOnPct > 95, `headbandOnPct ${r.headbandOnPct} should be >95`)

  // Strong signal.
  assert(r.signalQualityPct > 90, `signalQualityPct ${r.signalQualityPct} should be >90`)
  assertEquals(r.artifactsLevel, 'низкий')

  // No headband shift in this session.
  assertEquals(r.signalShiftAtSec, null)
  assertEquals(r.signalShiftSeverity, null)

  // Band ranges from the brief (relative powers in %).
  assert(r.alphaMedianRel >= 15 && r.alphaMedianRel <= 50,
    `alpha median ${r.alphaMedianRel} out of expected range`)
  assert(r.thetaMedianRel >= 5 && r.thetaMedianRel <= 30,
    `theta median ${r.thetaMedianRel} out of expected range`)
  assert(r.betaMedianRel > 0 && r.betaMedianRel < 40,
    `beta median ${r.betaMedianRel} out of expected range`)

  // Bands sum to ~100% (allow rounding).
  const sum = r.alphaMedianRel + r.thetaMedianRel + r.betaMedianRel +
              r.gammaMedianRel + r.deltaMedianRel
  assert(sum > 95 && sum < 105, `band sum ${sum} should be ~100`)

  // Thirds populated.
  assert(r.thetaFirstThird > 0 && r.thetaLastThird > 0)
  assert(r.alphaFirstThird > 0 && r.alphaLastThird > 0)

  // HR present (Muse Athena has heart-rate sensor).
  assertExists(r.hrMedian)
  assert(r.hrMedian! >= 40 && r.hrMedian! <= 120,
    `hrMedian ${r.hrMedian} not in human range`)
  assertExists(r.hrFirstThird)
  assertExists(r.hrLastThird)

  // Timeline 30s: 60 min / 30 sec ≈ 120 windows.
  assert(r.timeline30s.length >= 115 && r.timeline30s.length <= 125,
    `timeline windows ${r.timeline30s.length} not in [115, 125]`)

  // Electrodes all in some categorical state.
  for (const e of ['TP9', 'AF7', 'AF8', 'TP10'] as const) {
    assert(['ok', 'warn', 'bad'].includes(r.electrodesStatus[e]))
  }
})

Deno.test('signal_shift.csv — headband shifted around minute 27', async () => {
  const csv = await loadFixture('signal_shift.csv')
  const r = parseMindMonitorCSV(csv)

  // Around 50 min.
  assert(r.durationSec >= 2700 && r.durationSec <= 3300,
    `durationSec ${r.durationSec} not in [2700, 3300]`)

  // HSI itself is fine (headband still on skin, just shifted).
  assert(r.signalQualityPct > 90,
    `signalQualityPct ${r.signalQualityPct} should still be high — HSI doesn't catch shifts`)

  // The shift detector must catch it. Brief expects: signalShiftAtSec in [1500, 1700].
  assertExists(r.signalShiftAtSec)
  assert(r.signalShiftAtSec! >= 1200 && r.signalShiftAtSec! <= 1900,
    `signalShiftAtSec ${r.signalShiftAtSec} not in [1200, 1900] (window around minute 27)`)

  // Severity should be 'high' if both markers fired.
  assertExists(r.signalShiftSeverity)
  assert(r.signalShiftSeverity === 'high' || r.signalShiftSeverity === 'medium')
})

Deno.test('ParseError on too-short session', () => {
  // 4-minute session — synthetic.
  const header = 'TimeStamp,Delta_TP9,Delta_AF7,Delta_AF8,Delta_TP10,' +
    'Theta_TP9,Theta_AF7,Theta_AF8,Theta_TP10,' +
    'Alpha_TP9,Alpha_AF7,Alpha_AF8,Alpha_TP10,' +
    'Beta_TP9,Beta_AF7,Beta_AF8,Beta_TP10,' +
    'Gamma_TP9,Gamma_AF7,Gamma_AF8,Gamma_TP10,' +
    'HSI_TP9,HSI_AF7,HSI_AF8,HSI_TP10,HeadBandOn,Heart_Rate'
  const rows = [header]
  // 240 rows, 1 sec apart = 4 min.
  for (let i = 0; i < 240; i++) {
    const ts = new Date(Date.parse('2026-05-15T06:00:00') + i * 1000).toISOString()
      .replace('T', ' ').slice(0, -1)
    rows.push(`${ts},0.1,0.1,0.1,0.1,0.2,0.2,0.2,0.2,0.3,0.3,0.3,0.3,0.1,0.1,0.1,0.1,0.0,0.0,0.0,0.0,1,1,1,1,1,65`)
  }

  try {
    parseMindMonitorCSV(rows.join('\n'))
    throw new Error('expected ParseError')
  } catch (e) {
    assert(e instanceof ParseError, `expected ParseError, got ${e?.constructor?.name}`)
    assertEquals((e as ParseError).code, 'too_short')
  }
})

Deno.test('ParseError on missing required column', () => {
  const csv = 'TimeStamp,Heart_Rate\n2026-05-15 06:00:00.000,65\n'
  try {
    parseMindMonitorCSV(csv)
    throw new Error('expected ParseError')
  } catch (e) {
    assert(e instanceof ParseError)
    assertEquals((e as ParseError).code, 'structure')
  }
})

Deno.test('ParseError on headband off >50% of session', () => {
  const header = 'TimeStamp,Delta_TP9,Delta_AF7,Delta_AF8,Delta_TP10,' +
    'Theta_TP9,Theta_AF7,Theta_AF8,Theta_TP10,' +
    'Alpha_TP9,Alpha_AF7,Alpha_AF8,Alpha_TP10,' +
    'Beta_TP9,Beta_AF7,Beta_AF8,Beta_TP10,' +
    'Gamma_TP9,Gamma_AF7,Gamma_AF8,Gamma_TP10,' +
    'HSI_TP9,HSI_AF7,HSI_AF8,HSI_TP10,HeadBandOn,Heart_Rate'
  const rows = [header]
  // 10 min, headband=0 on 60% of rows.
  for (let i = 0; i < 600; i++) {
    const ts = new Date(Date.parse('2026-05-15T06:00:00') + i * 1000).toISOString()
      .replace('T', ' ').slice(0, -1)
    const hbo = i % 5 === 0 ? '1' : '0'  // 20% on
    rows.push(`${ts},0.1,0.1,0.1,0.1,0.2,0.2,0.2,0.2,0.3,0.3,0.3,0.3,0.1,0.1,0.1,0.1,0.0,0.0,0.0,0.0,1,1,1,1,${hbo},65`)
  }

  try {
    parseMindMonitorCSV(rows.join('\n'))
    throw new Error('expected ParseError')
  } catch (e) {
    assert(e instanceof ParseError)
    assertEquals((e as ParseError).code, 'headband_off')
  }
})
