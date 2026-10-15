import { mean, extreme, smooth } from './formulaMath'

type Bar = { open: number; high: number; low: number; close: number; volume?: number }

export interface BullBearTrendV2Row {
  supported: boolean
  ready: boolean
  k: number | null
  d: number | null
  dp: number | null
  dpMean: number | null
  lowPos: number | null
  atr: number | null
  e5: number | null
  e21: number | null
  e55: number | null
  rv: number | null
  obv5: number | null
  baseStop: number | null
  stop: number | null
  bottomCount: number | null
  topCount: number | null
  bottomRaw: boolean
  topRaw: boolean
  bottomSignal: boolean
  tryPre: boolean
  trySignal: boolean
  tryAge: number | null
  addPre: boolean
  addSignal: boolean
  topSignal: boolean
  breakdown: boolean
  exitRaw: boolean
  exitSignal: boolean
  reduceRaw: boolean
  reduceSignal: boolean
}

/** 多空趋势V2；30分钟按原式的8根/日偏移取量，周/月线只计算曲线而不发信号。 */
export function calculateBullBearTrendV2(bars: readonly Bar[], period: string): BullBearTrendV2Row[] {
  const halfHour = period === '30m'
  const supported = halfHour || period === '1d'
  const nFast = halfHour ? 27 : 20
  const nBreak = halfHour ? 8 : 6
  const highs: (number | null)[] = []
  const lows: (number | null)[] = []
  const volumes: (number | null)[] = []
  const trueRanges: (number | null)[] = []
  const signedVolumes: (number | null)[] = []
  const baseStops: (number | null)[] = []
  const result: BullBearTrendV2Row[] = []
  let count = 0
  let k: number | null = null
  let d: number | null = null
  let e5: number | null = null
  let e21: number | null = null
  let e55: number | null = null
  let dpMean: number | null = null
  let lastBottom: number | null = null
  let lastTop: number | null = null
  let lastTry: number | null = null
  const blocked = { bottom: -1, try: -1, add: -1, top: -1, exit: -1, reduce: -1 }
  type Channel = keyof typeof blocked
  const filter = (channel: Channel, condition: boolean, i: number, n: number) => {
    if (!condition || i <= blocked[channel]) return false
    blocked[channel] = i + n
    return true
  }
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]
    const previous = result[i - 1]
    const valid = [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) && bar.close > 0 && bar.high >= bar.low
    highs.push(valid ? bar.high : null)
    lows.push(valid ? bar.low : null)
    volumes.push(valid && bar.volume != null && Number.isFinite(bar.volume) && bar.volume >= 0 ? bar.volume : null)
    trueRanges.push(null)
    signedVolumes.push(null)
    baseStops.push(null)
    const row: BullBearTrendV2Row = {
      supported, ready: false, k: null, d: null, dp: null, dpMean: null, lowPos: null,
      atr: null, e5: null, e21: null, e55: null, rv: null, obv5: null, baseStop: null, stop: null,
      bottomCount: null, topCount: null, bottomRaw: false, topRaw: false, bottomSignal: false,
      tryPre: false, trySignal: false, tryAge: null, addPre: false, addSignal: false, topSignal: false,
      breakdown: false, exitRaw: false, exitSignal: false, reduceRaw: false, reduceSignal: false,
    }
    result.push(row)
    if (!valid) {
      count = 0
      k = d = e5 = e21 = e55 = dpMean = lastBottom = lastTop = lastTry = null
      for (const key of Object.keys(blocked) as Channel[]) blocked[key] = -1
      continue
    }
    count += 1
    row.ready = count > 80
    const close = bar.close
    e5 = smooth(e5, close, 2 / 6)
    e21 = smooth(e21, close, 2 / 22)
    e55 = smooth(e55, close, 2 / 56)
    row.e5 = e5
    row.e21 = e21
    row.e55 = e55
    if (count >= 2) {
      const delta = close - bars[i - 1].close
      trueRanges[i] = Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i - 1].close), Math.abs(bar.low - bars[i - 1].close))
      signedVolumes[i] = delta === 0 ? 0 : volumes[i] === null ? null : Math.sign(delta) * volumes[i]!
    }
    row.atr = mean(trueRanges, i, 14)
    const lowFast = extreme(lows, i, nFast)
    const highFast = extreme(highs, i, nFast, true)
    if (lowFast !== null && highFast !== null) {
      const rsv = 100 * (close - lowFast) / Math.max(highFast - lowFast, 0.0001)
      k = smooth(k, rsv, 1 / 5)
      d = smooth(d, k, 1 / 3)
      row.k = k
      row.d = d
      row.dp = 3 * k - 2 * d
      dpMean = smooth(dpMean, row.dp, 2 / 5)
      row.dpMean = dpMean
    }
    const low55 = extreme(lows, i, 55)
    const high55 = extreme(highs, i, 55, true)
    const pos = low55 === null || high55 === null ? null : 100 * (close - low55) / Math.max(high55 - low55, 0.0001)
    row.lowPos = pos === null ? null : 100 - pos
    let volumeBase: number | null = null
    if (halfHour) {
      if (count > 40) {
        const prior = [8,16,24,32,40].map(offset => volumes[i - offset])
        if (prior.every(value => value !== null)) volumeBase = (prior as number[]).reduce((sum, value) => sum + value, 0) / 5
      }
    } else volumeBase = mean(volumes, i - 1, 20)
    if (volumeBase !== null && volumes[i] !== null) row.rv = volumes[i]! / Math.max(volumeBase, 1)
    const signedMean = mean(signedVolumes, i, 5)
    row.obv5 = signedMean === null ? null : signedMean * 5
    const volumeGood = row.rv !== null && row.rv >= (halfHour ? 1.05 : 1.10) && row.obv5 !== null && row.obv5 > 0
    if (pos !== null && row.dp !== null && row.atr !== null) {
      row.bottomCount = Number(pos <= 20) + Number(row.dp <= 25) + Number(close < e21 - row.atr)
      row.topCount = Number(pos >= 80) + Number(row.dp >= 75) + Number(close > e21 + 1.4 * row.atr)
    }
    row.bottomRaw = row.bottomCount !== null && row.bottomCount >= 2
    row.topRaw = row.topCount !== null && row.topCount >= 2
    // 原式先对原始条件整段FILTER，再以OK/READY遮罩；预热期也会消耗冷却窗口。
    const bottomFiltered = filter('bottom', row.bottomRaw && !previous?.bottomRaw, i, halfHour ? 6 : 5)
    row.bottomSignal = supported && row.ready && bottomFiltered
    if (row.bottomRaw) lastBottom = i
    if (row.topRaw) lastTop = i
    const low3 = extreme(lows, i, 3)
    const priorLow5 = extreme(lows, i - 3, 5)
    const higherLow = low3 !== null && priorLow5 !== null && low3 > priorLow5
    const momentum = row.dp !== null && previous?.dp != null && row.dp > 18 && previous.dp <= 18
    const volumeSupport = (row.rv !== null && row.rv >= 0.9) || (row.obv5 !== null && row.obv5 > 0)
    row.tryPre = lastBottom !== null && i - lastBottom < 20 && momentum && higherLow && volumeSupport
      && close > bar.open && close > bars[i - 1].close && close > e5 && row.atr !== null && close < e21 + 1.2 * row.atr
    const tryFiltered = filter('try', row.tryPre, i, halfHour ? 10 : 7)
    row.trySignal = supported && row.ready && tryFiltered
    if (row.trySignal) lastTry = i
    row.tryAge = lastTry === null ? null : i - lastTry
    const breakHigh = extreme(highs, i - 1, nBreak, true)
    row.addPre = row.tryAge !== null && row.tryAge < 30 && row.tryAge >= 4 && breakHigh !== null && close > breakHigh
      && close > e21 && previous?.e21 != null && e21 > previous.e21 && higherLow
      && row.dp !== null && row.dp >= 40 && row.dp <= 85 && volumeGood && row.atr !== null && close < e21 + 2 * row.atr
    const addFiltered = filter('add', row.addPre, i, halfHour ? 20 : 15)
    row.addSignal = supported && row.ready && addFiltered
    const topFiltered = filter('top', row.topRaw && !previous?.topRaw, i, halfHour ? 8 : 6)
    row.topSignal = supported && row.ready && topFiltered
    const priorLow8 = extreme(lows, i - 1, 8)
    row.baseStop = priorLow8 === null || row.atr === null ? null : priorLow8 - 0.15 * row.atr
    baseStops[i] = row.baseStop
    // STOP0是有期限的滚动最高值，并非从试仓起只升不降的持仓防守线。
    row.stop = extreme(baseStops, i, halfHour ? 12 : 10, true)
    row.breakdown = row.stop !== null && close < row.stop
    row.exitRaw = row.breakdown && !!previous?.breakdown && close < e21 && row.dp !== null && row.dp < 50
    const exitFiltered = filter('exit', row.exitRaw && !previous?.exitRaw, i, halfHour ? 10 : 8)
    row.exitSignal = supported && row.ready && exitFiltered
    const high3 = extreme(highs, i, 3, true)
    const priorHigh5 = extreme(highs, i - 3, 5, true)
    const lowerHigh = high3 !== null && priorHigh5 !== null && high3 < priorHigh5
    row.reduceRaw = lastTop !== null && i - lastTop < (halfHour ? 16 : 12) && lowerHigh
      && row.dp !== null && row.dpMean !== null && row.dp < row.dpMean && close < e5 && close < bars[i - 1].close && !row.exitSignal
    const reduceFiltered = filter('reduce', row.reduceRaw && !previous?.reduceRaw, i, halfHour ? 12 : 8)
    row.reduceSignal = supported && row.ready && reduceFiltered
  }
  return result
}
