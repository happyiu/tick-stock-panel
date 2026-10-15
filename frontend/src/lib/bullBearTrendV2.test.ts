import { expect, it } from 'vitest'
import { calculateBullBearTrendV2 } from './bullBearTrendV2'

function sample(count = 1000) {
  let seed = 42
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296 }
  let previous = 3
  return Array.from({ length: count }, (_, i) => {
    const close = previous + (random() - 0.5) * 0.06 + Math.sin(i / 17) * 0.008
    const open = previous + (random() - 0.5) * 0.008
    const high = Math.max(open, close) + random() * 0.012
    const low = Math.min(open, close) - random() * 0.012
    const volume = 1000 * (0.6 + random() * 1.2)
    previous = close
    return { open, high, low, close, volume }
  })
}

it('30分钟与日线分别使用27/20窗口，81根就绪；预热期仍计算原始条件及FILTER', () => {
  const data = sample()
  const day = calculateBullBearTrendV2(data, '1d')
  const half = calculateBullBearTrendV2(data, '30m')
  expect(day[18].dp).toBeNull()
  expect(day[19].dp).not.toBeNull()
  expect(half[25].dp).toBeNull()
  expect(half[26].dp).not.toBeNull()
  expect(day[79].ready).toBe(false)
  expect(day[80]).toMatchObject({ ready: true, supported: true, bottomRaw: true, bottomSignal: false, exitRaw: true, exitSignal: false })
  expect(day[80].dp).toBeCloseTo(10.166496234728395, 10)
  expect(half[80].dp).toBeCloseTo(6.590073351322218, 10)
  expect(day[80].lowPos).toBeCloseTo(94.73024044083972, 10)
  expect(day[878].dp).toBeGreaterThan(100)
  expect(day[500].dp).toBeLessThan(0)
})

it('30分钟只比较8/16/24/32/40根的量，日线比较前20根；OBV按涨跌方向求5根和', () => {
  const data = Array.from({ length: 100 }, (_, i) => ({ open: i + 0.9, close: i + 1, high: i + 2, low: i, volume: 100 }))
  data[79].volume = 10000
  data[80].volume = 200
  const half = calculateBullBearTrendV2(data, '30m')
  const day = calculateBullBearTrendV2(data, '1d')
  expect(half[80].rv).toBe(2)
  expect(day[80].rv).toBeCloseTo(200 / 595, 12)
  expect(half[80].obv5).toBe(10500)
})

it.each(['1d', '30m'])('%s固定样本六类信号符合原式，两个周期使用独立冷却参数', period => {
  const result = calculateBullBearTrendV2(sample(), period)
  const expected = period === '1d' ? {
    bottomSignal: [172,279,384,390,423,431,496,517,591,598,628,720,744,803,812,861,867,921],
    trySignal: [107,198,540,625,738,749,760,822,959],
    addSignal: [644,981],
    topSignal: [122,210,218,326,341,358,440,548,559,576,652,763,873,965,972,981],
    reduceSignal: [150,161,248,267,276,339,352,361,458,482,494,553,571,586,595,692,705,715,776,787,798,889,908,917,979],
    exitSignal: [173,278,385,420,432,491,518,590,631,712,721,746,803,828,869,921],
  } : {
    bottomSignal: [172,281,384,496,517,591,598,720,744,805,812,861,922],
    trySignal: [109,205,422,510,541,626,739,760,858,960],
    addSignal: [210,438,547,644,872,966],
    topSignal: [122,210,331,341,355,440,549,559,576,652,764,873,967,981],
    reduceSignal: [150,172,248,267,280,339,352,365,458,482,495,553,571,586,692,705,718,776,798,812,889,908,923,979],
    exitSignal: [173,279,385,420,432,494,518,590,631,712,746,803,828,869,921],
  }
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    expect(result.flatMap((row, i) => row[key] ? [i] : []), key).toEqual(expected[key])
  }
  expect(result.every(row => !row.exitSignal || !row.reduceSignal)).toBe(true)
})

it('动态防守按前8根低点及10/12根滚动最大值，不锚定试仓且允许旧最大值到期下降', () => {
  const data = sample()
  const day = calculateBullBearTrendV2(data, '1d')
  const half = calculateBullBearTrendV2(data, '30m')
  expect(day[80].tryAge).toBeNull()
  expect(day[80].stop).toBeCloseTo(2.9952152278771123, 12)
  expect(half[80].stop).toBeCloseTo(3.0054425192528416, 12)
  expect(day[81].stop!).toBeLessThan(day[80].stop!)
  expect(day[80].baseStop).toBeCloseTo(Math.min(...data.slice(72,80).map(row => row.low)) - 0.15 * day[80].atr!, 12)
  expect(day[172]).toMatchObject({ breakdown: true, exitRaw: false, exitSignal: false })
  expect(day[173]).toMatchObject({ breakdown: true, exitRaw: true, exitSignal: true })
  expect(day[174]).toMatchObject({ exitRaw: true, exitSignal: false })
  expect(day[494]).toMatchObject({ exitRaw: true, exitSignal: false, reduceSignal: true })
  expect(half[494]).toMatchObject({ exitSignal: true, reduceSignal: false })
})

it('周线和月线不发信号，保留曲线但明确不支持；追加未来K线不修改历史结果', () => {
  const data = sample()
  const day = calculateBullBearTrendV2(data, '1d')
  for (const period of ['1w','1mo','5m']) {
    const other = calculateBullBearTrendV2(data, period)
    expect(other.every(row => !row.supported && !row.bottomSignal && !row.trySignal && !row.addSignal && !row.topSignal && !row.reduceSignal && !row.exitSignal)).toBe(true)
    expect(other[100].dp).toBe(day[100].dp)
  }
  expect(day.slice(0,173)).toEqual(calculateBullBearTrendV2(data.slice(0,173), '1d'))
  expect(day.slice(0,80).every(row => !row.trySignal && !row.exitSignal)).toBe(true)
})

it('空数据、零振幅、缺失量价安全降级；缺口后重新累计81根且不继承观察与冷却', () => {
  expect(calculateBullBearTrendV2([], '30m')).toEqual([])
  const data = Array.from({ length: 190 }, () => ({ open: 3, high: 3, low: 3, close: 3, volume: 0 }))
  expect(calculateBullBearTrendV2(data, '1d')[80]).toMatchObject({ ready: true, dp: 0, lowPos: 100, rv: 0, obv5: 0, stop: 3, trySignal: false })
  data[90].close = NaN
  const gap = calculateBullBearTrendV2(data, '1d')
  expect(gap[91]).toMatchObject({ ready: false, dp: null, tryAge: null, stop: null })
  expect(gap[170].ready).toBe(false)
  expect(gap[171].ready).toBe(true)
  const missing = sample().map(row => ({ ...row, volume: undefined }))
  expect(calculateBullBearTrendV2(missing, '30m')[200]).toMatchObject({ rv: null, obv5: null, trySignal: false, addSignal: false })
})
