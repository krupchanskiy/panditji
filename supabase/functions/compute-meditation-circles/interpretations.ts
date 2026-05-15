/* Template-based interpretation generator + linter.
 *
 * Rule from the brief: no LLM at runtime — texts come from templates here.
 * Gives determinism, zero cost, full control over tone. Calm, precise, no
 * evaluative language. The forbidden-word list is enforced via assertNoForbidden,
 * which throws — unit tests pin every template against it.
 *
 * Versioned via INTERPRETATION_VERSION. When templates change, bump the version
 * and get-session-report will lazily re-generate on next read. */

import type { CircleAgg } from './compute.ts'

export const INTERPRETATION_VERSION = 'v1'

export type SessionForInterpretation = {
  signalShiftSeverity: 'medium' | 'high' | null
  signalShiftAtSec: number | null
  deepeningReliable: boolean | null
  deepeningPct: number | null
  thetaFirstThird: number
  thetaLastThird: number
  alphaFirstThird: number
  alphaLastThird: number
  alphaMedianRel: number
  autoTags: string[]
}

export type Phase = {
  label: string
  range: [number, number]    // [from_circle, to_circle], inclusive, 1-based
  note: string
}

export type Interpretations = {
  main: string
  calm: string | null         // null when calm metrics aren't computed
  phases: Phase[]
}

/* Forbidden words — exact substrings (case-insensitive). Emoji also banned. */
const FORBIDDEN_PHRASES = [
  'идеально', 'отлично', 'великолепно', 'потрясающе',
  'не случайно', 'не зря',
  'молодец', 'хорошо получилось', 'хорошая работа',
  'к сожалению', 'к несчастью',
  'лучший', 'выдающийся', 'уникальный',
  'продолжай в том же духе', 'не останавливайся',
] as const

/* Unicode emoji ranges — Misc Symbols, Dingbats, Emoticons, Misc Pictographs, Transport,
 * Supplemental Symbols, Symbols & Pictographs Extended-A, Flag pairs. */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}]/u

export function assertNoForbidden(text: string, context: string): void {
  const lower = text.toLowerCase()
  for (const phrase of FORBIDDEN_PHRASES) {
    if (lower.includes(phrase)) {
      throw new Error(`[interpretation lint] "${phrase}" found in ${context}: ${text}`)
    }
  }
  if (EMOJI_RE.test(text)) {
    throw new Error(`[interpretation lint] emoji found in ${context}: ${text}`)
  }
}

/* ── main caption ─────────────────────────────────────────────────────── */

export function generateMainCaption(
  s: SessionForInterpretation, circles: CircleAgg[],
): string {
  const text = pickMainTemplate(s, circles)
  assertNoForbidden(text, 'main')
  return text
}

function pickMainTemplate(s: SessionForInterpretation, circles: CircleAgg[]): string {
  // Priority 1: headband shift (highest — overrides everything else).
  if (s.signalShiftSeverity === 'high' && s.signalShiftAtSec !== null) {
    const minute = Math.floor(s.signalShiftAtSec / 60)
    return `На ${minute}-й минуте в сигнале произошла резкая смена — скорее всего, ` +
           `повязка сдвинулась или провернулась. Дальше Muse записывала другой ` +
           `участок мозга, и метрики углубления для этой сессии недостоверны. ` +
           `Стоит проверить посадку повязки в следующий раз.`
  }
  if (s.signalShiftSeverity === 'medium' && s.signalShiftAtSec !== null) {
    const minute = Math.floor(s.signalShiftAtSec / 60)
    return `На ${minute}-й минуте в данных заметна ступенька — возможно, ` +
           `повязка подвинулась. Результаты после этого момента стоит ` +
           `интерпретировать с осторожностью.`
  }

  // Priority 2: drowsiness (auto-tagged earlier).
  if (s.autoTags.includes('признаки сонливости')) {
    return `Theta нарастает вместе с Delta во второй половине, пульс снижается. ` +
           `Это похоже не на углубление, а на дрёму. Возможно, не хватило сна.`
  }

  // Priority 3: regression. Strong negative deepening.
  if (s.deepeningReliable && s.deepeningPct !== null && s.deepeningPct < -15) {
    return `Theta снижается к концу сессии. Возможно, концентрация рассеялась, ` +
           `или повязка к концу села хуже — посмотри сигнал по электродам.`
  }

  // Priority 4: strong deepening (reliable).
  if (s.deepeningReliable && s.deepeningPct !== null && s.deepeningPct > 40 && circles.length > 0) {
    const N = circles.length
    const thetaFirst = s.thetaFirstThird
    // Find first circle in last 2/3 where Theta sustained ≥1.3× opening.
    const deepStartIdx = circles.findIndex(
      (c, i) => i >= Math.floor(N / 3) && c.theta_rel > thetaFirst * 1.3,
    )
    const deepStartLabel = deepStartIdx > 0 ? `с ${deepStartIdx + 1}-го круга — ` : ''
    return `Углубление ${deepStartLabel}к ${N}-му кругу Theta выросла с ${Math.round(thetaFirst)}% ` +
           `до ${Math.round(s.thetaLastThird)}%. Похоже на переход от сосредоточения (dharana) ` +
           `к погружённости (dhyana).`
  }

  // Priority 5: flat session (reliable, near zero).
  if (s.deepeningReliable && s.deepeningPct !== null && Math.abs(s.deepeningPct) < 15) {
    const alphaAvg = Math.round((s.alphaFirstThird + s.alphaLastThird) / 2)
    return `Сессия ровная: показатели держались стабильными от первого до последнего круга. ` +
           `Alpha около ${alphaAvg}% — устойчивая собранность.`
  }

  // Priority 6: moderate reliable deepening (everything else with reliable=true).
  if (s.deepeningReliable && s.deepeningPct !== null) {
    return `Умеренное углубление: Theta выросла с ${Math.round(s.thetaFirstThird)}% ` +
           `до ${Math.round(s.thetaLastThird)}%.`
  }

  // Fallback: unreliable deepening, no shift detected — say so plainly.
  return `Сессия записана. Объективную динамику оценить сложно — посмотри график по кругам.`
}

/* ── calm caption ─────────────────────────────────────────────────────── */

export function generateCalmCaption(
  longestCalmSec: number, longestCalmAtSec: number, paceMinPerCircle: number,
): string | null {
  if (longestCalmSec === 0 || paceMinPerCircle <= 0) return null

  const min = Math.floor(longestCalmSec / 60)
  const sec = longestCalmSec % 60
  const circleNum = Math.floor((longestCalmAtSec / 60) / paceMinPerCircle) + 1

  const minSecPart = sec === 0
    ? `${min} мин`
    : (min === 0 ? `${sec} сек` : `${min} мин ${sec} сек`)

  const text = `Самый длинный отрезок стабильности — ${minSecPart}, ` +
               `начался на ${circleNum}-м круге.`
  assertNoForbidden(text, 'calm')
  return text
}
