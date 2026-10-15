import { calculateAngelDevil } from './angelDevil'
import { calculateKdDivergence, type KdDivergenceRow } from './kdDivergence'

export interface KdEnhancedRow extends KdDivergenceRow {
  bottomFractal: boolean
  topFractal: boolean
  bottomDistance: number | null
  topDistance: number | null
  bottomWatch: boolean
  topWatch: boolean
  turnBull: boolean
  turnBear: boolean
  trial: boolean
  reduce: boolean
}

/** 增强版按分型确认日比较价格与K的5根极值，不把信号回填到两根前的拐点。 */
export function calculateKdEnhanced(bars: readonly { high: number; low: number; close: number }[]): KdEnhancedRow[] {
  const valid = (bar: typeof bars[number]) => [bar.high, bar.low, bar.close].every(Number.isFinite) && bar.high >= bar.low
  const kd = calculateKdDivergence(bars, true)
  const trends = calculateAngelDevil(bars.map(bar => valid(bar) ? bar.close : NaN))
  const kLow: (number | null)[] = []
  const kHigh: (number | null)[] = []
  for (let i = 0; i < kd.length; i += 1) {
    const window = kd.slice(Math.max(0, i - 4), i + 1).map(row => row.k)
    const complete = window.length === 5 && window.every(value => value !== null)
    kLow.push(complete ? Math.min(...window as number[]) : null)
    kHigh.push(complete ? Math.max(...window as number[]) : null)
  }
  const result: KdEnhancedRow[] = []
  let count = 0
  let lastBottom: number | null = null
  let lastTop: number | null = null
  let bottomObservation: number | null = null
  let topObservation: number | null = null
  for (let i = 0; i < bars.length; i += 1) {
    const row: KdEnhancedRow = {
      ...kd[i], bottomDivergence: false, topDivergence: false, bottomLineStart: null, topLineStart: null,
      bottomFractal: false, topFractal: false, bottomDistance: null, topDistance: null,
      bottomWatch: false, topWatch: false, turnBull: false, turnBear: false, trial: false, reduce: false,
    }
    result.push(row)
    if (!valid(bars[i])) {
      count = 0
      lastBottom = lastTop = bottomObservation = topObservation = null
      continue
    }
    count += 1
    if (count >= 5) {
      const pivot = bars[i - 2]
      row.bottomFractal = pivot.low < bars[i - 3].low && pivot.low < bars[i - 4].low
        && pivot.low <= bars[i - 1].low && pivot.low <= bars[i].low
      row.topFractal = pivot.high > bars[i - 3].high && pivot.high > bars[i - 4].high
        && pivot.high >= bars[i - 1].high && pivot.high >= bars[i].high
      row.bottomDistance = lastBottom === null ? null : i - lastBottom
      row.topDistance = lastTop === null ? null : i - lastTop
      // COUNT(REF(分型,1),60)只考虑先前的分型；即使最近分型过近也不改找更早的。
      if (row.bottomFractal && lastBottom !== null && row.bottomDistance! >= 5 && row.bottomDistance! <= 60) {
        row.bottomDivergence = pivot.low < bars[lastBottom - 2].low
          && kLow[i] !== null && kLow[lastBottom] !== null && kLow[i]! > kLow[lastBottom]!
      }
      if (row.topFractal && lastTop !== null && row.topDistance! >= 5 && row.topDistance! <= 60) {
        row.topDivergence = pivot.high > bars[lastTop - 2].high
          && kHigh[i] !== null && kHigh[lastTop] !== null && kHigh[i]! < kHigh[lastTop]!
      }
      if (row.bottomFractal) lastBottom = i
      if (row.topFractal) lastTop = i
    }
    if (row.bottomDivergence) bottomObservation = i
    if (row.topDivergence) topObservation = i
    row.bottomWatch = bottomObservation !== null && i - bottomObservation < 25
    row.topWatch = topObservation !== null && i - topObservation < 25
    row.turnBull = trends[i].signal === 'buy'
    row.turnBear = trends[i].signal === 'sell'
    row.trial = row.bottomWatch && row.turnBull && row.k !== null && row.d !== null && row.k > row.d
    row.reduce = row.topWatch && ((row.deadCross && row.k !== null && row.k >= 50) || row.turnBear)
  }
  return result
}
