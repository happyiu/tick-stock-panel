import { calculateMarketTrendScoreSeries, type MarketTrendHistory } from './marketTrend'
import { expect, it } from 'vitest'
import type { TechnicalScoreRow } from './api'
import type { DowAnalysis } from './dow'
import { calculateCompositeTrendSeries, assessMarketTrendComposite as assess } from './marketTrendComposite'
const date = '2026-11-05'
function sample() {
  const daily = { as_of: date, categories: [
    { id: 'momentum', indicators: [
      { id: 'macd', score: 60, momentum: 'BULL_SHRINKING', raw_values: {} },
      { id: 'rsi', direction: 'RISING', raw_values: { rsi14: 70 } },
    ] },
    { id: 'volume_price', available: true, coverage: 100, score: 60, indicators: [] },
  ] } as unknown as TechnicalScoreRow
  const dow = { status: 'ok', dataThrough: date, trend: 'up', damaged: false, events: [], paths: [], levels: {} } as unknown as DowAnalysis
  return { daily, dow }
}
it('combines contributions without intermediate rounding', () => {
  const { daily, dow } = sample()
  const result = assess(85, daily, dow, date)
  expect(result.factors.map(f => f.score)).toEqual([85, 80, 60, 76, 60])
  expect(result.score).toBe(76) // 34 + 16 + 9 + 7.6 + 9
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
  daily.categories![0].indicators[0].score = NaN
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
