import { expect, it } from 'vitest'
import { latestAngelDevilSignal, marketTrendAssessment, marketTrendRowsThrough, summarizeDailyMarketTrendHistory, summarizeThirtyMinuteMarketTrendHistory, summarizeWeeklyMarketTrendHistory } from './marketTrend'
import type { KlineRow } from './api'

it('takes the latest angel-devil cross in chronological rows', () => {
  const closes = [...Array<number>(30).fill(100), 110, 112, 90, 88, 105]
  const result = latestAngelDevilSignal(closes.map((close, i) => ({ date: `bar-${i}`, close })))

  expect(result.latest).toEqual({ signal: 'retreat', date: 'bar-32' })
  expect(result.barCount).toBe(3)
  expect(result.hasComparableBars).toBe(true)
})

it('does not report a signal before there are two valid angel-devil values', () => {
  const result = latestAngelDevilSignal(Array.from({ length: 21 }, (_, i) => ({ date: `bar-${i}`, close: 100 })))

  expect(result.latest).toBeNull()
  expect(result.hasComparableBars).toBe(false)
})

it('locates confirmed weekly signals on their first matching daily close and ends before the reverse day', () => {
  const closes = [...Array<number>(30).fill(100), 110, 112, 90]
  const day = (week: number, daysBeforeFriday: number) => new Date(Date.UTC(2025, 0, 3 + week * 7 - daysBeforeFriday)).toISOString().slice(0, 10)
  const weekly = closes.map((close, week) => ({ date: day(week, 0), close }))
  const daily = closes.flatMap((close, week) => [4, 3, 2, 1, 0].map((offset, index) => ({
    date: day(week, offset),
    close: week === 30 ? [100, 110, 110, 110, 110][index]
      : week === 32 ? [112, 112, 90, 100, 90][index] : close,
  })))

  const summary = summarizeWeeklyMarketTrendHistory(weekly, daily)
  expect(summary.attack.completed[0]).toMatchObject({
    startDate: day(30, 3), endDate: day(32, 3), startPrice: 110, endPrice: 112, barCount: 11,
  })
  expect(summary.retreat.current?.startDate).toBe(day(32, 2))
  expect(summary.retreat.current?.maxFallPercent).toBe(0)
  expect(summarizeWeeklyMarketTrendHistory(weekly, daily.filter(row => row.date < day(32, 4))).attack.completedCount).toBe(0)
})

it('summarizes daily signals through the day before the reverse signal', () => {
  const closes = [...Array<number>(30).fill(100), 110, 112, 90]
  const rows = closes.map((close, index) => ({ date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10), close }))
  const summary = summarizeDailyMarketTrendHistory(rows)
  expect(summary.attack.completed[0]).toMatchObject({
    startDate: rows[30].date, endDate: rows[31].date, startPrice: 110, endPrice: 112, barCount: 2,
  })
  expect(summary.retreat.current?.startDate).toBe(rows[32].date)
})

it('summarizes 30F signals with intraday dates and elapsed hours', () => {
  const closes = [...Array<number>(30).fill(100), 110, 112, 90]
  const rows = closes.map((close, index) => ({
    date: new Date(Date.UTC(2026, 0, 1, 9, 30 + index * 30)).toISOString().slice(0, 16).replace('T', ' '),
    close,
  }))
  const summary = summarizeThirtyMinuteMarketTrendHistory(rows)
  expect(summary.attack.completed[0]).toMatchObject({
    startDate: rows[30].date, endDate: rows[31].date, barCount: 2,
  })
  expect(summary.attack.completed[0].durationDays * 24).toBeCloseTo(0.5)
  expect(summary.retreat.current?.startDate).toBe(rows[32].date)
})

it.each([
  ['attack', 'attack', 'attack', 100, '强多头共振', '多头共振，短期同步走强'],
  ['attack', 'attack', 'retreat', 85, '多头短期调整', '多头环境中的短期调整'],
  ['attack', 'retreat', 'attack', 70, '多头调整中反弹', '中期上涨背景下尝试止跌'],
  ['attack', 'retreat', 'retreat', 55, '多头中期调整', '调整仍在进行'],
  ['retreat', 'attack', 'attack', 45, '空头环境中反弹', '空头背景下反弹延续'],
  ['retreat', 'attack', 'retreat', 30, '空头反弹减弱', '反弹可能减弱'],
  ['retreat', 'retreat', 'attack', 15, '空头短期反抽', '空头环境中的短期反抽'],
  ['retreat', 'retreat', 'retreat', 0, '强空头共振', '三周期空头共振'],
] as const)('scores weekly/daily/30F as %s/%s/%s', (weekly, daily, thirtyMinute, score, environment, explanation) => {
  expect(marketTrendAssessment(weekly, daily, thirtyMinute)).toMatchObject({ score, environment, explanation, usedThirtyMinute: true })
})

it('waits for all three periods before combining their signals', () => {
  expect(marketTrendAssessment('attack', null, 'retreat')).toBeNull()
})

it.each([
  ['attack', 'attack', 93, '周日多头共振'],
  ['attack', 'retreat', 63, '周线进攻，日线调整'],
  ['retreat', 'attack', 38, '周线撤退，日线反弹'],
  ['retreat', 'retreat', 8, '周日空头共振'],
] as const)('scores weekly/daily %s/%s when 30F is missing', (weekly, daily, score, environment) => {
  expect(marketTrendAssessment(weekly, daily, null)).toMatchObject({ score, environment, usedThirtyMinute: false })
})

it('keeps each timeframe within the selected bar, excluding unfinished daily and weekly bars for intraday replay', () => {
  const rows = (dates: string[]): KlineRow[] => dates.map(date => ({ date, open: 1, high: 1, low: 1, close: 1 }))
  const daily = rows(['2026-11-04', '2026-11-05'])
  const thirtyMinute = rows(['2026-11-05 14:00:00', '2026-11-05 14:30:00', '2026-11-05 15:00:00'])

  expect(marketTrendRowsThrough(daily, '1d', '30m', '2026-11-05 14:30:00').map(row => row.date)).toEqual(['2026-11-04'])
  expect(marketTrendRowsThrough(daily, '1w', '30m', '2026-11-05 14:30:00').map(row => row.date)).toEqual(['2026-11-04'])
  expect(marketTrendRowsThrough(thirtyMinute, '30m', '30m', '2026-11-05 14:30:00').map(row => row.date)).toEqual(thirtyMinute.slice(0, 2).map(row => row.date))
  expect(marketTrendRowsThrough(thirtyMinute, '30m', '1d', '2026-11-05').map(row => row.date)).toEqual(thirtyMinute.map(row => row.date))
})
