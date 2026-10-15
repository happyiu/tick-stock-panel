export interface AngelDevilRow {
  ma5: number | null
  ma13: number | null
  ma21: number | null
  ma34: number | null
  angel: number | null
  devil: number | null
  bull: boolean | null
  signal: 'buy' | 'sell' | null
}

export const ANGEL_DEVIL_MA = [
  { key: 'ma5', label: 'MA5', period: 5, color: '#FFFFFF', lightColor: '#374151', width: 2 },
  { key: 'ma13', label: 'MA13', period: 13, color: '#00FF00', lightColor: '#15803D', width: 1 },
  { key: 'ma21', label: 'MA21', period: 21, color: '#FFFF00', lightColor: '#A16207', width: 2 },
  { key: 'ma34', label: 'MA34', period: 34, color: '#FF00FF', lightColor: '#C026D3', width: 1 },
] as const

/** 通达信天使魔鬼：只使用当前及之前的收盘价，按图表周期计算。 */
export function calculateAngelDevil(closes: readonly number[]): AngelDevilRow[] {
  const result: AngelDevilRow[] = []
  const sums = [0, 0, 0, 0]
  let validCount = 0
  let angel: number | null = null
  let devil: number | null = null
  for (let i = 0; i < closes.length; i += 1) {
    const close = closes[i]
    if (!Number.isFinite(close)) {
      validCount = 0
      sums.fill(0)
      angel = devil = null
    } else {
      validCount += 1
      angel = angel === null ? close : angel + 2 / 3 * (close - angel)
      if (validCount >= 21) {
        let covariance = 0
        for (let j = 0; j < 21; j += 1) {
          // 中心化价格，避免常数价格的浮点误差制造交叉；Σ(j-10)² = 770。
          covariance += (j - 10) * (closes[i - 20 + j] - closes[i - 20])
        }
        const projected = close + 20 * covariance / 770
        // EMA 从第一个有效输入起算；回归窗口不足时不补零、不发信号。
        devil = devil === null ? projected : devil + 2 / 43 * (projected - devil)
      }
    }
    const averages = ANGEL_DEVIL_MA.map(({ period }, index) => {
      if (validCount === 0) return null
      sums[index] += close
      if (validCount > period) sums[index] -= closes[i - period]
      return validCount >= period ? sums[index] / period : null
    })
    const prev = result[i - 1]
    let signal: AngelDevilRow['signal'] = null
    if (angel !== null && devil !== null && prev?.angel != null && prev.devil !== null) {
      if (angel > devil && prev.angel <= prev.devil) signal = 'buy'
      else if (angel < devil && prev.angel >= prev.devil) signal = 'sell'
    }
    result.push({
      ma5: averages[0], ma13: averages[1], ma21: averages[2], ma34: averages[3],
      angel, devil,
      bull: angel !== null && devil !== null ? angel >= devil : null,
      signal,
    })
  }
  return result
}
