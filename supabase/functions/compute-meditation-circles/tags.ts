/* Auto-tags for a meditation session.
 * Pure: takes session + circles, returns string[]. Tag strings are exact, on Russian —
 * they're used in filters, in interpretation templates, in UI. Do not rename casually. */

import { mean, std } from '../parse-meditation-csv/stats.ts'
import type { CircleAgg } from './compute.ts'

export type SessionForTags = {
  signalShiftSeverity: 'medium' | 'high' | null
  deepeningReliable: boolean | null   // null = not computed (no circles confirmed)
  deepeningPct: number | null
  thetaFirstThird: number
  thetaLastThird: number
  deltaFirstThird: number
  deltaLastThird: number
  hrFirstThird: number | null
  hrLastThird: number | null
  signalQualityPct: number
  headbandOnPct: number
  durationCategory: 'standard' | 'short' | 'long'
}

/* Tag thresholds — exported for tests. */
export const TAG_THRESHOLDS = {
  deepeningStrong: 70,           // > 70% → 'глубокое углубление'
  deepeningFlat: 10,             // |Δ| < 10% → 'ровная сессия'
  deepeningRegression: -10,      // < -10% → 'обратная динамика'
  earlyThetaRiseMultiplier: 1.3,
  earlyThetaRiseMaxCircle: 8,
  mindWanderingBetaPct: 25,
  drowsyThetaMultiplier: 1.3,
  drowsyDeltaMultiplier: 1.2,
  drowsyHrMultiplier: 0.95,
  signalNoisyMin: 70,
  signalNoisyMax: 90,
  signalTechIssues: 70,          // < 70% → 'технические проблемы'
  headbandLooseMin: 80,
  headbandLooseMax: 95,
  headbandPoorFit: 80,
  flatFirstHalfAlphaStdMax: 3,
} as const

export function computeAutoTags(s: SessionForTags, circles: CircleAgg[]): string[] {
  const tags: string[] = []

  /* Headband-shift artefact takes priority — affects how every other metric reads. */
  if (s.signalShiftSeverity === 'high') tags.push('артефакт повязки')
  else if (s.signalShiftSeverity === 'medium') tags.push('смена сигнала')

  if (s.deepeningReliable === false) tags.push('недостоверное углубление')

  /* Deepening verdicts only when value is trustworthy. */
  if (s.deepeningReliable === true && s.deepeningPct !== null) {
    if (s.deepeningPct > TAG_THRESHOLDS.deepeningStrong) tags.push('глубокое углубление')
    if (Math.abs(s.deepeningPct) < TAG_THRESHOLDS.deepeningFlat) tags.push('ровная сессия')
    if (s.deepeningPct < TAG_THRESHOLDS.deepeningRegression) tags.push('обратная динамика')

    /* Early deepening: Theta sustained ≥1.3× the opening from circle ≤8. */
    if (circles.length > 0) {
      const opening = circles[0].theta_rel
      if (opening > 0) {
        const earlyIdx = circles.findIndex((c, i) =>
          i >= 3 && c.theta_rel > opening * TAG_THRESHOLDS.earlyThetaRiseMultiplier,
        )
        if (earlyIdx >= 3 && earlyIdx + 1 <= TAG_THRESHOLDS.earlyThetaRiseMaxCircle) {
          tags.push('раннее углубление')
        }
      }
    }
  }

  /* Mind wandering in the opening third. */
  if (circles.length >= 3) {
    const firstThird = circles.slice(0, Math.floor(circles.length / 3))
    const avgBeta = mean(firstThird.map(c => c.beta_rel))
    if (avgBeta > TAG_THRESHOLDS.mindWanderingBetaPct) tags.push('много блуждания')
  }

  /* Drowsiness: Theta↑ + Delta↑ + HR↓. Only when no headband artefact (would false-positive). */
  if (s.signalShiftSeverity === null &&
      s.hrFirstThird !== null && s.hrLastThird !== null &&
      s.thetaFirstThird > 0 && s.deltaFirstThird > 0) {
    const thetaGrows = s.thetaLastThird > s.thetaFirstThird * TAG_THRESHOLDS.drowsyThetaMultiplier
    const deltaGrows = s.deltaLastThird > s.deltaFirstThird * TAG_THRESHOLDS.drowsyDeltaMultiplier
    const hrFell = s.hrLastThird < s.hrFirstThird * TAG_THRESHOLDS.drowsyHrMultiplier
    if (thetaGrows && deltaGrows && hrFell) tags.push('признаки сонливости')
  }

  /* Technical quality. */
  if (s.signalQualityPct < TAG_THRESHOLDS.signalTechIssues) {
    tags.push('технические проблемы')
  } else if (s.signalQualityPct < TAG_THRESHOLDS.signalNoisyMax) {
    tags.push('шумная запись')
  }
  if (s.headbandOnPct < TAG_THRESHOLDS.headbandPoorFit) {
    tags.push('повязка плохо сидела')
  } else if (s.headbandOnPct < TAG_THRESHOLDS.headbandLooseMax) {
    tags.push('повязка отваливалась')
  }

  /* Duration category — only non-standard ones get tagged. */
  if (s.durationCategory === 'short') tags.push('короче обычной')
  if (s.durationCategory === 'long')  tags.push('длиннее обычной')

  /* Flat first half: Alpha std < 3. Only meaningful with enough circles. */
  if (circles.length >= 4) {
    const firstHalf = circles.slice(0, Math.ceil(circles.length / 2))
    if (std(firstHalf.map(c => c.alpha_rel)) < TAG_THRESHOLDS.flatFirstHalfAlphaStdMax) {
      tags.push('ровная первая половина')
    }
  }

  return tags
}
