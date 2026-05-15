/* Detect 1-4 phases inside a session: Вход / Плато / Углубление / Сонливость.
 * Pure. Output: array of phases with circle ranges and a short, neutral note.
 *
 * Priority order:
 *   1. Вход — opening circles with Alpha well below median (slow start)
 *   2. Сонливость — auto-tag triggered (Theta+Delta↑, HR↓ in 2nd half)
 *   3. Углубление — reliable deepening with magnitude > 30%
 *   4. Плато — fallback, fills gaps between named phases */

import type { CircleAgg } from './compute.ts'
import {
  Phase, SessionForInterpretation, assertNoForbidden,
} from './interpretations.ts'

export function detectPhases(s: SessionForInterpretation, circles: CircleAgg[]): Phase[] {
  if (circles.length === 0) return []
  const N = circles.length
  const phases: Phase[] = []

  let entryEnd = 0   // circles 1..entryEnd belong to "Вход" (0 = no entry phase)

  if (circles[0].alpha_rel < s.alphaMedianRel * 0.85) {
    for (let i = 1; i < Math.floor(N / 2); i++) {
      if (circles[i].alpha_rel >= s.alphaMedianRel * 0.95) {
        entryEnd = i
        break
      }
    }
    if (entryEnd > 0) {
      pushPhase(phases, {
        label: 'Вход',
        range: [1, entryEnd],
        note: `Первые ${entryEnd} ${plural(entryEnd, 'круг', 'круга', 'кругов')} ум собирался. ` +
              `После — стабилизация Alpha.`,
      })
    }
  }

  /* Drowsiness phase: Theta climbs in 2nd half. */
  if (s.autoTags.includes('признаки сонливости')) {
    const halfIdx = Math.floor(N / 2)
    const opening = s.thetaFirstThird
    const sleepStart = opening > 0
      ? circles.findIndex((c, i) => i >= halfIdx && c.theta_rel > opening * 1.3)
      : -1
    if (sleepStart > 0) {
      if (sleepStart > entryEnd + 2) {
        pushPhase(phases, {
          label: 'Плато',
          range: [entryEnd + 1, sleepStart],
          note: plateauNote(s),
        })
      }
      pushPhase(phases, {
        label: 'Сонливость',
        range: [sleepStart + 1, N],
        note: `Theta нарастает вместе с Delta, пульс снижается — характерный паттерн дрёмы.`,
      })
      return phases
    }
  }

  /* Deepening phase: reliable AND magnitude > 30%. */
  if (s.deepeningReliable && s.deepeningPct !== null && s.deepeningPct > 30) {
    const thirdIdx = Math.floor(N / 3)
    const opening = s.thetaFirstThird
    const deepStart = opening > 0
      ? circles.findIndex((c, i) => i >= thirdIdx && c.theta_rel > opening * 1.3)
      : -1
    if (deepStart > 0) {
      if (deepStart > entryEnd + 2) {
        pushPhase(phases, {
          label: 'Плато',
          range: [entryEnd + 1, deepStart],
          note: plateauNote(s),
        })
      }
      pushPhase(phases, {
        label: 'Углубление',
        range: [deepStart + 1, N],
        note: `С ${deepStart + 1}-го круга Theta начала расти, ` +
              `к ${N}-му — ${Math.round(s.thetaLastThird)}%.`,
      })
      return phases
    }
  }

  /* Fallback Плато(s). */
  if (phases.length === 0) {
    pushPhase(phases, {
      label: 'Плато',
      range: [1, N],
      note: `Стабильная динамика, без выраженных переходов.`,
    })
  } else if (entryEnd > 0 && entryEnd < N) {
    pushPhase(phases, {
      label: 'Плато',
      range: [entryEnd + 1, N],
      note: plateauNote(s),
    })
  }

  return phases
}

function plateauNote(s: SessionForInterpretation): string {
  return `Theta держалась около ${Math.round(s.thetaFirstThird)}%, без сильных колебаний.`
}

function pushPhase(arr: Phase[], p: Phase): void {
  assertNoForbidden(p.note, `phase[${p.label}]`)
  arr.push(p)
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}
