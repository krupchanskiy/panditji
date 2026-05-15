/* Pure: resample a 16-bin normalized baseline to N points (matching today's circles).
 *
 * Today's session has N circles. Baseline is stored as 16 bins along position [0..1].
 * For each circle i (0..N-1), we compute its midpoint position (i+0.5)/N, then
 * locate that position on the 16-bin grid and linearly interpolate. This keeps
 * "today vs baseline" honest when N != 16. */

import { BIN_COUNT } from './baseline.ts'

export function resampleFromBins(bins: number[], targetN: number): number[] {
  if (bins.length !== BIN_COUNT) {
    throw new Error(`resampleFromBins: expected ${BIN_COUNT} bins, got ${bins.length}`)
  }
  if (targetN <= 0) return []

  const out: number[] = []
  for (let i = 0; i < targetN; i++) {
    const pos = (i + 0.5) / targetN              // 0..1 (centre of the i-th slice)
    const binPos = pos * BIN_COUNT - 0.5         // -0.5 .. 15.5 (centre of bin k is at k)
    const lo = Math.max(0, Math.floor(binPos))
    const hi = Math.min(BIN_COUNT - 1, Math.ceil(binPos))
    if (lo === hi) {
      out.push(round2(bins[lo]))
    } else {
      const t = binPos - lo
      out.push(round2(bins[lo] + t * (bins[hi] - bins[lo])))
    }
  }
  return out
}

function round2(v: number): number { return Math.round(v * 100) / 100 }
