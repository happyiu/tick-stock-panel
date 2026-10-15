export interface Boll2Row {
  mid: number | null
  upper: number | null
  lower: number | null
}

export const BOLL2_LINES = [
  { key: 'mid', label: 'BOLL', color: '#FFFFFF', lightColor: '#374151' },
  { key: 'upper', label: 'UB', color: '#FFFF00', lightColor: '#A16207' },
  { key: 'lower', label: 'LB', color: '#FF00FF', lightColor: '#C026D3' },
] as const

/** 原公式：每日相对各自MA20的偏差平方再取MA20，三条轨道均REF一根。 */
export function calculateBoll2(closes: readonly number[]): Boll2Row[] {
  const result: Boll2Row[] = []
  const squares = Array<number>(20).fill(0)
  let count = 0
  let sum = 0
  let squareSum = 0
  let previous: Boll2Row = { mid: null, upper: null, lower: null }
  for (let i = 0; i < closes.length; i += 1) {
    // REF取上一根结果，即使当前收盘价改变，当前轨道也不变。
    result.push(previous)
    previous = { mid: null, upper: null, lower: null }
    const close = closes[i]
    if (!Number.isFinite(close)) {
      count = sum = squareSum = 0
      squares.fill(0)
      continue
    }
    count += 1
    sum += close
    if (count > 20) sum -= closes[i - 20]
    if (count < 20) continue
    const mid = sum / 20
    const square = (close - mid) ** 2
    const slot = (count - 20) % 20
    squareSum += square - squares[slot]
    squares[slot] = square
    const width = count >= 39 ? 2 * Math.sqrt(Math.max(0, squareSum / 20)) : null
    previous = {
      mid,
      upper: width === null ? null : mid + width,
      lower: width === null ? null : mid - width,
    }
  }
  return result
}
