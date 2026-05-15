/* Statistical helpers for meditation CSV parser.
 * All functions assume input is already filtered: no NaN/null/undefined.
 * Tested directly via parser.test.ts on real CSV fixtures. */

export function mean(arr: number[]): number {
  if (arr.length === 0) return NaN
  let sum = 0
  for (const v of arr) sum += v
  return sum / arr.length
}

export function median(arr: number[]): number {
  if (arr.length === 0) return NaN
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/* Linear-interpolated quantile, 0 ≤ q ≤ 1. quantile(arr, 0.75) → P75. */
export function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return NaN
  if (arr.length === 1) return arr[0]
  const sorted = [...arr].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo])
}

export function std(arr: number[]): number {
  if (arr.length < 2) return 0
  const m = mean(arr)
  let s = 0
  for (const v of arr) s += (v - m) ** 2
  return Math.sqrt(s / (arr.length - 1))
}
