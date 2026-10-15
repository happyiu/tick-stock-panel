import { mean, extreme, smooth } from './formulaMath'

export interface EtfSwingBar {
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export interface EtfSwingV2Row {
  ready: boolean
  k: number | null
  d: number | null
  rsi: number | null
  atr: number | null
  std: number | null
  m5: number | null
  m20: number | null
  roc5: number | null
  roc20: number | null
  macd: number | null
  pos20: number | null
  bias: number | null
  volumeRatio: number | null
  neck: number | null
  kUp: boolean
  bottomCount: number | null
  topCount: number | null
  bottomRaw: boolean
  topRaw: boolean
  bottomSignal: boolean
  topSignal: boolean
  buyPre: boolean
  buySignal: boolean
  addPre: boolean
  addSignal: boolean
  sellPre: boolean
  sellSignal: boolean
  hasBuy: boolean
  buyAge: number | null
  buyLow: number | null
  stop: number | null
  defense: number | null
  fail: boolean
  exitSignal: boolean
}

const EPS = 0.000001


/** ETF波段操盘V2：仅消费当前周期的OHLCV，FILTER按已发出的信号独立冷却。 */
export function calculateEtfSwingV2(bars: readonly EtfSwingBar[]): EtfSwingV2Row[] {
  const closes: (number | null)[] = []
  const highs: (number | null)[] = []
  const lows: (number | null)[] = []
  const volumes: (number | null)[] = []
  const trueRanges: (number | null)[] = []
  const result: EtfSwingV2Row[] = []
  let count = 0
  let k: number | null = null
  let d: number | null = null
  let up14: number | null = null
  let ab14: number | null = null
  let fast: number | null = null
  let slow: number | null = null
  let dea: number | null = null
  let lastBottom: number | null = null
  let lastTop: number | null = null
  let lastBuy: number | null = null
  let buyLow: number | null = null
  const blocked = { bottom: -1, top: -1, buy: -1, add: -1, sell: -1, exit: -1 }
  type Channel = keyof typeof blocked
  const filter = (channel: Channel, condition: boolean, index: number, period: number) => {
    if (!condition || index <= blocked[channel]) return false
    blocked[channel] = index + period
    return true
  }
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]
    const previous = result[i - 1]
    const valid = [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) && bar.close > 0 && bar.high >= bar.low
    closes.push(valid ? bar.close : null)
    highs.push(valid ? bar.high : null)
    lows.push(valid ? bar.low : null)
    volumes.push(valid && bar.volume != null && Number.isFinite(bar.volume) && bar.volume >= 0 ? bar.volume : null)
    trueRanges.push(null)
    const row: EtfSwingV2Row = {
      ready: false, k: null, d: null, rsi: null, atr: null, std: null, m5: null, m20: null,
      roc5: null, roc20: null, macd: null, pos20: null, bias: null, volumeRatio: null, neck: null,
      kUp: false, bottomCount: null, topCount: null, bottomRaw: false, topRaw: false,
      bottomSignal: false, topSignal: false, buyPre: false, buySignal: false, addPre: false, addSignal: false,
      sellPre: false, sellSignal: false, hasBuy: false, buyAge: null, buyLow: null, stop: null, defense: null,
      fail: false, exitSignal: false,
    }
    result.push(row)
    if (!valid) {
      count = 0
      k = d = up14 = ab14 = fast = slow = dea = lastBottom = lastTop = lastBuy = buyLow = null
      for (const channel of Object.keys(blocked) as Channel[]) blocked[channel] = -1
      continue
    }
    count += 1
    row.ready = count > 65
    const close = bar.close
    fast = smooth(fast, close, 2 / 13)
    slow = smooth(slow, close, 2 / 27)
    const dif = fast - slow
    dea = smooth(dea, dif, 2 / 10)
    row.macd = 2 * (dif - dea)
    if (count >= 2) {
      const prevClose = bars[i - 1].close
      const delta = close - prevClose
      up14 = smooth(up14, Math.max(delta, 0), 1 / 14)
      ab14 = smooth(ab14, Math.abs(delta), 1 / 14)
      row.rsi = 100 * up14 / Math.max(ab14, EPS)
      trueRanges[i] = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))
    }
    const low9 = extreme(lows, i, 9)
    const high9 = extreme(highs, i, 9, true)
    if (low9 !== null && high9 !== null) {
      const rsv = (close - low9) / Math.max(high9 - low9, EPS) * 100
      k = smooth(k, rsv, 1 / 3)
      d = smooth(d, k, 1 / 3)
      row.k = k
      row.d = d
      row.kUp = previous?.k != null && k > d && k > previous.k
    }
    row.m5 = mean(closes, i, 5)
    row.m20 = mean(closes, i, 20)
    const atr = mean(trueRanges, i, 14)
    row.atr = atr === null ? null : Math.max(atr, EPS)
    if (count > 5) row.roc5 = (close / Math.max(bars[i - 5].close, EPS) - 1) * 100
    if (count > 20) row.roc20 = (close / Math.max(bars[i - 20].close, EPS) - 1) * 100
    const low20 = extreme(lows, i, 20)
    const high20 = extreme(highs, i, 20, true)
    if (low20 !== null && high20 !== null) row.pos20 = (close - low20) / Math.max(high20 - low20, EPS) * 100
    if (row.m20 !== null) {
      let squareSum = 0
      for (let j = i - 19; j <= i; j += 1) squareSum += (closes[j]! - row.m20) ** 2
      // 通达信STD为估算标准差，使用N-1；不能复用boll2的自定义偏差宽度。
      row.std = Math.sqrt(squareSum / 19)
      if (row.atr !== null) row.bias = (close - row.m20) / row.atr
    }
    const priorVolumeMean = mean(volumes, i - 1, 20)
    if (priorVolumeMean !== null && volumes[i] !== null) row.volumeRatio = volumes[i]! / Math.max(priorVolumeMean, 1)
    if (row.pos20 !== null && row.rsi !== null && row.bias !== null && row.roc20 !== null && row.std !== null && row.atr !== null && row.m20 !== null) {
      row.bottomCount = Number(row.pos20 <= 20) + Number(row.rsi <= 35) + Number(row.bias <= -1)
        + Number(row.roc20 <= -8) + Number(close <= row.m20 - 2 * row.std + 0.2 * row.atr)
      row.topCount = Number(row.pos20 >= 85) + Number(row.rsi >= 68) + Number(row.bias >= 1)
        + Number(row.roc20 >= 8) + Number(close >= row.m20 + 2 * row.std - 0.2 * row.atr)
    }
    row.bottomRaw = row.ready && row.bottomCount !== null && row.bottomCount >= 2
    row.topRaw = row.ready && row.topCount !== null && row.topCount >= 2
    row.bottomSignal = filter('bottom', row.bottomRaw && !previous?.bottomRaw, i, 10)
    row.topSignal = filter('top', row.topRaw && !previous?.topRaw, i, 10)
    if (row.bottomRaw) lastBottom = i
    if (row.topRaw) lastTop = i
    const low3 = extreme(lows, i, 3)
    const priorLow3 = extreme(lows, i - 3, 3)
    const lowUp = low3 !== null && priorLow3 !== null && low3 > priorLow3
    const momentum = previous?.rsi != null && previous.roc5 !== null && previous.macd !== null && row.rsi !== null && row.roc5 !== null
      ? Number(row.rsi > previous.rsi) + Number(row.roc5 > previous.roc5) + Number(row.macd > previous.macd) : 0
    row.buyPre = row.ready && lastBottom !== null && i - lastBottom < 25 && lowUp
      && close > bar.open && close > bars[i - 1].close && row.m5 !== null && close > row.m5
      && momentum >= 2 && row.kUp && row.volumeRatio !== null && row.volumeRatio >= 0.8 && row.bias !== null && row.bias <= 0.8
    row.buySignal = filter('buy', row.buyPre, i, 8)
    if (row.buySignal) { lastBuy = i; buyLow = low3 }
    row.buyAge = lastBuy === null ? null : i - lastBuy
    row.buyLow = buyLow
    row.neck = extreme(highs, i - 1, 5, true)
    const breakout = row.neck !== null && row.atr !== null && previous?.neck != null && previous.atr !== null
      && close > row.neck + 0.1 * row.atr && bars[i - 1].close <= previous.neck + 0.1 * previous.atr
    row.addPre = row.ready && row.buyAge !== null && row.buyAge < 30 && row.buyAge >= 5
      && breakout && lowUp && row.kUp && row.k !== null && row.k >= 50 && row.volumeRatio !== null && row.volumeRatio >= 1.1
      && row.bias !== null && row.bias <= 1.8
    row.addSignal = filter('add', row.addPre, i, 10)
    const weak = previous?.rsi != null && previous.roc5 !== null && previous.macd !== null && previous.k !== null
      && row.rsi !== null && row.roc5 !== null && row.k !== null
      ? Number(row.rsi < previous.rsi) + Number(row.roc5 < previous.roc5) + Number(row.macd < previous.macd) + Number(row.k < previous.k) : 0
    row.sellPre = row.ready && lastTop !== null && i - lastTop < 25 && close < bar.open && close < bars[i - 1].low
      && weak >= 2 && row.k !== null && previous.k !== null && row.k < previous.k
    row.sellSignal = filter('sell', row.sellPre, i, 10)
    row.hasBuy = row.buyAge !== null && row.buyAge < 60
    row.stop = buyLow === null || row.atr === null ? null : buyLow - 0.15 * row.atr
    row.defense = row.hasBuy ? row.stop : null
    // 上一根收盘必须比较上一根自己的STOPP，不能两根都套用当前防守参考。
    row.fail = row.hasBuy && row.stop !== null && close < row.stop && previous?.stop != null && bars[i - 1].close < previous.stop
    row.exitSignal = filter('exit', row.fail && !previous?.fail, i, 10)
  }
  return result
}
