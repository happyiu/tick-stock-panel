export interface KdDivergenceRow {
  rsv: number | null
  k: number | null
  d: number | null
  goldenCross: boolean
  deadCross: boolean
  lowCross: boolean
  highCross: boolean
  buy: boolean
  sell: boolean
  bottomDivergence: boolean
  topDivergence: boolean
  bottomLineStart: number | null
  topLineStart: number | null
}

/** 原式的双EMA随机指标；背离只在当前交叉确认后出现。 */
export function calculateKdDivergence(bars: readonly { high: number; low: number; close: number }[], neutralFlat = false): KdDivergenceRow[] {
  const result: KdDivergenceRow[] = []
  let count = 0
  let rsv: number | null = null
  let k: number | null = null
  let lastGolden: number | null = null
  let lastDead: number | null = null
  for (let i = 0; i < bars.length; i += 1) {
    const row: KdDivergenceRow = {
      rsv: null, k: null, d: null,
      goldenCross: false, deadCross: false, lowCross: false, highCross: false,
      buy: false, sell: false, bottomDivergence: false, topDivergence: false,
      bottomLineStart: null, topLineStart: null,
    }
    result.push(row)
    const bar = bars[i]
    if (![bar.high, bar.low, bar.close].every(Number.isFinite) || bar.high < bar.low) {
      count = 0
      rsv = k = lastGolden = lastDead = null
      continue
    }
    count += 1
    if (count < 9) continue
    let low = Infinity
    let high = -Infinity
    for (let j = i - 8; j <= i; j += 1) {
      low = Math.min(low, bars[j].low)
      high = Math.max(high, bars[j].high)
    }
    if (high === low && !neutralFlat) {
      // 原式此时分母为0；留空并重启平滑，不补造中性值或跨过缺口发出交叉。
      rsv = k = lastGolden = lastDead = null
      continue
    }
    const raw = high === low ? 50 : (bar.close - low) / (neutralFlat ? Math.max(high - low, 0.000001) : high - low) * 100
    rsv = rsv === null ? raw : (rsv + raw) / 2
    k = k === null ? rsv : (k + rsv) / 2
    row.rsv = rsv
    row.k = k
    const prev = result[i - 1]
    const prev2 = result[i - 2]
    if (prev?.k == null || prev2?.k == null) continue
    const d = (k + prev.k + prev2.k) / 3
    row.d = d
    if (prev.d === null) continue
    row.goldenCross = k > d && prev.k <= prev.d
    row.deadCross = d > k && prev.d <= prev.k
    row.lowCross = row.goldenCross && k <= 50
    row.highCross = row.deadCross && k >= 80
    row.buy = row.goldenCross && d < 8
    row.sell = row.deadCross && d > 85
    // BARSLAST(REF(CROSS,1))+1恰好引用上一次同方向交叉，不能先更新索引。
    if (row.goldenCross && lastGolden !== null) {
      row.bottomDivergence = bars[lastGolden].close > bar.close && k > result[lastGolden].k!
      if (row.bottomDivergence) row.bottomLineStart = lastGolden + 1
    }
    if (row.deadCross && lastDead !== null) {
      row.topDivergence = bars[lastDead].close < bar.close && result[lastDead].d! > d
      if (row.topDivergence) row.topLineStart = lastDead + 1
    }
    if (row.goldenCross) lastGolden = i
    if (row.deadCross) lastDead = i
  }
  return result
}
