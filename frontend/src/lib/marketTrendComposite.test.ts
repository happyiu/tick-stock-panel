import { calculateMarketTrendScoreSeries, type MarketTrendHistory } from './marketTrend'
import { expect, it } from 'vitest'
import type { TechnicalScoreRow } from './api'
import type { DowAnalysis } from './dow'
import { identifyTurningRegion, calculateTurningRegionSeries, continuousMacdScore, calculateTrendSpeedSeries, calculateCompositeTrendSeries, assessMarketTrendComposite as assess } from './marketTrendComposite'
const date = '2026-11-05'
function sample() {
  const daily = { as_of: date, categories: [
    { id: 'momentum', indicators: [
      { id: 'macd', score: 60, momentum: 'BULL_SHRINKING', raw_values: { dif: 0, hist: 0, previous_hist: 0 } },
      { id: 'rsi', direction: 'RISING', raw_values: { rsi14: 70 } },
    ] },
    { id: 'volume_price', available: true, coverage: 100, score: 60, indicators: [] },
    { id: 'price_position', indicators: [{ id: 'ma20_atr_position', raw_values: { atr14: 1, close: 100 } }] },
  ] } as unknown as TechnicalScoreRow
  const dow = { status: 'ok', dataThrough: date, trend: 'up', damaged: false, events: [], paths: [], levels: {} } as unknown as DowAnalysis
  return { daily, dow }
}
it('combines contributions without intermediate rounding', () => {
  const { daily, dow } = sample()
  const result = assess(85, daily, dow, date)
  expect(result.factors.map(f => f.score)).toEqual([85, 80, 50, 76, 60])
  expect(result.score).toBe(74) // 34 + 16 + 7.5 + 7.6 + 9
  expect(result.available).toBe(true)
})
it.each([['up', false, 80], ['up', true, 40], ['down', false, 20], ['down', true, 60], ['unknown', false, 50]] as const)('maps %s damaged=%s', (trend, damaged, score) => {
  const { daily, dow } = sample()
  expect(assess(50, daily, { ...dow, trend, damaged }, date).factors[1].score).toBe(score)
})
it('fails closed for missing, partial, nonfinite or mismatched inputs', () => {
  const { daily, dow } = sample()
  expect(assess(null, daily, dow, date).score).toBeNull()
  expect(assess(50, daily, dow, '2026-11-04').factors.slice(1).every(f => f.score === null)).toBe(true)
  daily.categories![1].coverage = 99
  expect(assess(50, daily, dow, date).score).toBeNull()
  daily.categories![0].indicators[0].raw_values.hist = NaN
  expect(assess(50, daily, dow, date).factors[2].score).toBeNull()
})
it('requires active ordinary divergence, deduplicates evidence, and allows conflicting warnings', () => {
  const { daily, dow } = sample()
  const [macd, rsi] = daily.categories![0].indicators
  rsi.raw_values.rsi14 = 100
  expect(assess(100, daily, dow, date).topWarning).toBe(false)
  macd.recent_divergence = 'TOP_DIVERGENCE'
  rsi.divergence = 'HIDDEN_TOP_DIVERGENCE'
  expect(assess(100, daily, dow, date).topWarning).toBe(false)
  macd.divergence = rsi.divergence = 'TOP_DIVERGENCE'
  expect(assess(100, daily, dow, date).evidence).toHaveLength(1)
  rsi.divergence = 'BOTTOM_DIVERGENCE'
  const result = assess(100, daily, dow, date)
  expect(result.topWarning && result.bottomWarning).toBe(true)
  expect(result.factors[3].score).toBe(100)
  rsi.direction = 'FALLING'; rsi.raw_values.rsi14 = 0; rsi.divergence = 'TOP_DIVERGENCE'
  expect(assess(0, daily, dow, date).factors[3].score).toBe(0)
})
it('distinguishes damage from confirmation and uses authoritative levels and dates', () => {
  const { daily, dow } = sample()
  dow.basis = { structure: 'up', confirmation: { kind: 'confirm', direction: 'up', date, anchorDate: date, value: 10, volumeRatio: null } }
  dow.paths = [{ kind: 'damage', direction: 'down', value: 9, satisfied: false, anchorDate: date }]
  expect(assess(50, daily, dow, date).structure).toBe('向上结构确认')
  dow.damaged = true
  dow.events = [{ kind: 'damage', direction: 'up', date, anchorDate: date, value: 9, volumeRatio: null }]
  const result = assess(50, daily, dow, date)
  expect(result.structure).toBe('上涨结构受损')
  expect(result.eventDate).toBe(date)
  expect(result.levels).toEqual([{ name: '结构保护价', value: 9 }])
})

it('replays composite factors causally instead of applying the final Dow state to every bar', () => {
  const { daily, dow } = sample()
  const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
  const bars = [...Array<number>(30).fill(100), 110, 112, 90, 88, 105].map((close, i) => ({ date: day(i), close }))
  const scores = [32, 33, 34].map(i => ({ ...daily, as_of: day(i) }))
  const historicalDow: DowAnalysis = { ...dow, trend: 'down', damaged: false,
    pivots: ['high', 'low', 'high', 'low'].map(side => ({ date: day(29), confirmedAt: day(31), value: 100, side, label: '' })),
    events: [
      { kind: 'confirm', direction: 'up', date: day(31), anchorDate: day(29), value: 100, volumeRatio: null },
      { kind: 'damage', direction: 'up', date: day(33), anchorDate: day(29), value: 100, volumeRatio: null },
      { kind: 'reversal', direction: 'down', date: day(34), anchorDate: day(29), value: 100, volumeRatio: null },
    ] }
  const history: MarketTrendHistory = { '1w': bars, '1d': bars, '30m': [], dailyScores: scores, dailyDow: historicalDow }
  const chartRows = bars.slice(32)
  const originals = calculateMarketTrendScoreSeries(chartRows, '1d', history)
  const expected = scores.map((score, i) => assess(originals[i], score, { ...dow, dataThrough: score.as_of, trend: i === 2 ? 'down' : 'up', damaged: i === 1 }, score.as_of).score)
  expect(calculateCompositeTrendSeries(chartRows, '1d', history)).toEqual(expected)
  const truncated = { ...history, dailyScores: scores.slice(0, 1), dailyDow: { ...historicalDow, events: historicalDow.events.slice(0, 1) } }
  expect(calculateCompositeTrendSeries(chartRows.slice(0, 1), '1d', truncated)).toEqual(expected.slice(0, 1))
  expect(calculateCompositeTrendSeries([{ date: day(32) + ' 14:30' }], '30m', history)).toEqual([null])
  expect(calculateCompositeTrendSeries(chartRows, '1d', { ...history, dailyScores: undefined })).toEqual([null, null, null])
})

it('continuous MACD distinguishes bearish magnitudes, improves on deceleration and is price-scale invariant', () => {
  const { daily } = sample()
  const raw = daily.categories![0].indicators[0].raw_values
  Object.assign(raw, { dif: -0.5, hist: -0.1, previous_hist: -0.09 })
  const mild = continuousMacdScore(daily)!
  Object.assign(raw, { dif: -1, hist: -0.4, previous_hist: -0.3 })
  const strong = continuousMacdScore(daily)!
  expect(strong).toBeLessThan(mild)
  expect(strong).toBeGreaterThan(0)
  raw.previous_hist = -0.5
  expect(continuousMacdScore(daily)!).toBeGreaterThan(strong)
  const before = continuousMacdScore(daily)
  for (const field of ['dif', 'hist', 'previous_hist']) raw[field]! *= 100
  daily.categories![2].indicators[0].raw_values.atr14 = 100
  expect(continuousMacdScore(daily)).toBeCloseTo(before!)
  daily.categories![2].indicators[0].raw_values.atr14 = 0
  expect(continuousMacdScore(daily)).toBeNull()
})
it('price speed uses closed daily windows, preserves raw ATR/day units and has no future input', () => {
  const day = (i: number) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10)
  const dailyScores = Array.from({ length: 12 }, (_, i) => ({ as_of: day(i), categories: [{ id: 'price_position', indicators: [{ id: 'ma20_atr_position', raw_values: { close: 200 - i * i, atr14: 2 } }] }] })) as unknown as TechnicalScoreRow[]
  const history: MarketTrendHistory = { '1w': [], '1d': [], '30m': [], dailyScores }
  const rows = dailyScores.map(row => ({ date: row.as_of }))
  const result = calculateTrendSpeedSeries(rows, '1d', history)
  expect(result[4]).toEqual({ speed: null, speedChange: null })
  expect(result[5]).toEqual({ speed: -2.5, speedChange: null })
  expect(result[8]).toEqual({ speed: -5.5, speedChange: -3 })
  expect(calculateTrendSpeedSeries(rows.slice(0, 9), '1d', { ...history, dailyScores: dailyScores.slice(0, 9) })).toEqual(result.slice(0, 9))
  expect(calculateTrendSpeedSeries([{ date: day(8) + ' 14:30' }], '30m', history)[0].speed).toBe(-4.5)
  dailyScores[8].categories![0].indicators[0].raw_values.atr14 = 0
  expect(calculateTrendSpeedSeries([rows[8]], '1d', history)[0].speed).toBeNull()
})

it('requires price location, score change and speed change together for observation regions', () => {
  expect(identifyTurningRegion(20, 2, -0.2, 0.05)).toBe(-1)
  expect(identifyTurningRegion(80, -2, 0.2, -0.05)).toBe(1)
  expect(identifyTurningRegion(10, 0, -0.2, 0.1)).toBe(0)
  expect(identifyTurningRegion(10, 3, -0.2, -0.1)).toBe(0)
  expect(identifyTurningRegion(50, 3, -0.2, 0.1)).toBe(0)
  expect(identifyTurningRegion(90, -3, -0.2, -0.1)).toBe(0)
  expect(identifyTurningRegion(null, 3, -0.2, 0.1)).toBeNull()
  expect(identifyTurningRegion(10, null, -0.2, 0.1)).toBeNull()
  expect(identifyTurningRegion(10, 3, -0.2, NaN)).toBeNull()
})
it('daily observation regions use only closed-day evidence and keep historical labels stable', () => {
  const day = (i: number) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10)
  const { daily, dow } = sample()
  const bars = [...Array<number>(30).fill(100), 110, 112].map((close, i) => ({ date: day(i), close }))
  const dailyScores = Array.from({ length: 45 }, (_, i) => ({ ...daily, as_of: day(i), categories: daily.categories!.map(category => category.id === 'price_position'
    ? { ...category, indicators: [
      { ...category.indicators[0], raw_values: { atr14: 2, close: i < 35 ? 200 - i : 165 - (i - 35) * 0.1 } },
      { id: 'range_position_60', name: '位置', score: null, weight: null, status: '', detail: '', raw_values: {}, value: 10 },
    ] } : category.id === 'volume_price' ? { ...category, score: i < 35 ? 30 : 60 } : category) }))
  const dailyDow = { ...dow, dataThrough: day(44), pivots: ['high', 'low', 'high', 'low'].map(side => ({ date: day(0), confirmedAt: day(0), value: 100, side, label: '' })), events: [{ kind: 'confirm', date: day(0), direction: 'up', anchorDate: day(0), value: 100, volumeRatio: null }] }
  const history: MarketTrendHistory = { '1w': bars, '1d': bars, '30m': [], dailyScores, dailyDow }
  const rows = dailyScores.map(row => ({ date: row.as_of }))
  const result = calculateTurningRegionSeries(rows, '1d', history)
  expect(result[36].region).toBe(-1)
  expect(result[34].region).toBe(0)
  expect(result[38].region).toBe(0)
  expect(calculateTurningRegionSeries(rows.slice(0, 37), '1d', { ...history, dailyScores: dailyScores.slice(0, 37) })).toEqual(result.slice(0, 37))
  expect(calculateTurningRegionSeries([{ date: day(36) + ' 14:30' }], '30m', history)).toEqual([result[35]])
})
