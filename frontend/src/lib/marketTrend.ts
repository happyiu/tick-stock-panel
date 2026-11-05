import { calculateAngelDevil } from './angelDevil'
import { filterKlineRowsThrough } from './kline'
import type { KlinePeriod, KlineRow } from './api'

export const MARKET_TREND_PERIODS = ['1w', '1d', '30m'] as const
export type MarketTrendPeriod = typeof MARKET_TREND_PERIODS[number]
export type MarketTrendSignal = 'attack' | 'retreat'
export type MarketTrendHistory = Record<MarketTrendPeriod, readonly { date: string; close: number }[]>

export interface LatestAngelDevilSignal {
  signal: MarketTrendSignal
  date: string
}

export function marketTrendRowsThrough(
  rows: KlineRow[],
  period: MarketTrendPeriod,
  chartPeriod: KlinePeriod,
  through: string | null,
): KlineRow[] {
  if (!through) return rows
  const intraday = chartPeriod === '30m' && through.length >= 16
  if (intraday && through.slice(11, 16) < '15:00' && period !== '30m') {
    return rows.filter(row => row.date.slice(0, 10) < through.slice(0, 10))
  }
  const cutoff = period === '30m' && through.length === 10 ? `${through} 15:00` : through
  return filterKlineRowsThrough(rows, period, cutoff)
}

export function latestAngelDevilSignal(rows: readonly { date: string; close: number }[]) {
  const calculated = calculateAngelDevil(rows.map(row => row.close))
  let latest: LatestAngelDevilSignal | null = null
  let signalClose: number | null = null
  let signalIndex = -1
  let hasComparableBars = false

  for (let i = 0; i < calculated.length; i += 1) {
    const current = calculated[i]
    const previous = calculated[i - 1]
    if (current.angel !== null && current.devil !== null && previous?.angel != null && previous.devil !== null) {
      hasComparableBars = true
    }
    if (current.signal) {
      latest = { signal: current.signal === 'buy' ? 'attack' : 'retreat', date: rows[i].date }
      signalClose = rows[i].close
      signalIndex = i
    }
  }

  const currentClose = rows.at(-1)?.close
  const changePercent = latest && signalClose !== null && Number.isFinite(signalClose) && signalClose !== 0
    && currentClose !== undefined && Number.isFinite(currentClose)
    ? (currentClose / signalClose - 1) * 100
    : null

  return { latest, changePercent, barCount: signalIndex >= 0 ? rows.length - signalIndex : null, hasComparableBars }
}

export interface MarketTrendHistoricalSegment {
  startDate: string
  endDate: string
  startPrice: number
  endPrice: number
  changePercent: number
  durationDays: number
  barCount: number
  maxFallPercent: number
  maxRisePercent: number
}

export interface MarketTrendPhaseHistory {
  signalCount: number
  completedCount: number
  completed: MarketTrendHistoricalSegment[]
  averageChangePercent: number | null
  averageDurationDays: number | null
  averageBarCount: number | null
  averageMaxFallPercent: number | null
  averageMaxRisePercent: number | null
  maxFallPercent: number | null
  maxRisePercent: number | null
  current: MarketTrendHistoricalSegment | null
}

export interface MarketTrendHistorySummary {
  startDate: string | null
  endDate: string | null
  retreat: MarketTrendPhaseHistory
  attack: MarketTrendPhaseHistory
}

function dateOrdinal(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  return Date.UTC(year, month - 1, day) / 86_400_000
}

/** 周收盘确认信号后，回溯当周首次临时触发信号的日K，按日K统计区间。 */
export function summarizeWeeklyMarketTrendHistory(
  rows: readonly { date: string; close: number }[],
  dailyRows: readonly { date: string; close: number }[],
): MarketTrendHistorySummary {
  const calculated = calculateAngelDevil(rows.map(row => row.close))
  const events = calculated.flatMap((row, index) => {
    if (!row.signal) return []
    const weekEnd = dateOrdinal(rows[index].date)
    const weekStart = weekEnd - (new Date(weekEnd * 86_400_000).getUTCDay() + 6) % 7
    const previousCloses = rows.slice(0, index).map(bar => bar.close)
    const dailyIndex = dailyRows.findIndex(bar => {
      const day = dateOrdinal(bar.date)
      return day >= weekStart && day <= weekEnd
        && calculateAngelDevil([...previousCloses, bar.close]).at(-1)?.signal === row.signal
    })
    return [{ index: dailyIndex, signal: row.signal === 'buy' ? 'attack' as const : 'retreat' as const }]
  })
  return summarizeSignalHistory(rows, dailyRows, events)
}

/** 日线交叉信号及相邻反向信号之间的日K统计。 */
export function summarizeDailyMarketTrendHistory(
  dailyRows: readonly { date: string; close: number }[],
): MarketTrendHistorySummary {
  return summarizePeriodMarketTrendHistory(dailyRows, '1d')
}

/** 30F交叉信号及相邻反向信号之间的30分钟K线统计。 */
export function summarizeThirtyMinuteMarketTrendHistory(
  rows: readonly { date: string; close: number }[],
): MarketTrendHistorySummary {
  return summarizePeriodMarketTrendHistory(rows, '30m')
}

function summarizePeriodMarketTrendHistory(rows: readonly { date: string; close: number }[], period: '1d' | '30m') {
  const events = calculateAngelDevil(rows.map(row => row.close)).flatMap((row, index) => row.signal
    ? [{ index, signal: row.signal === 'buy' ? 'attack' as const : 'retreat' as const }]
    : [])
  return summarizeSignalHistory(rows, rows, events, period)
}

function summarizeSignalHistory(
  signalRows: readonly { date: string; close: number }[],
  dailyRows: readonly { date: string; close: number }[],
  events: readonly { index: number; signal: MarketTrendSignal }[],
  period: '1d' | '30m' = '1d',
): MarketTrendHistorySummary {
  const segment = (startIndex: number, endIndex: number): MarketTrendHistoricalSegment | null => {
    const startClose = dailyRows[startIndex]?.close
    const endClose = dailyRows[endIndex]?.close
    if (startClose == null || endClose == null || !Number.isFinite(startClose) || !Number.isFinite(endClose) || startClose === 0) return null
    let maxFallPercent = 0
    let maxRisePercent = 0
    for (let index = startIndex; index <= endIndex; index += 1) {
      const close = dailyRows[index]?.close
      if (!Number.isFinite(close)) continue
      maxFallPercent = Math.min(maxFallPercent, (close / startClose - 1) * 100)
      maxRisePercent = Math.max(maxRisePercent, (close / startClose - 1) * 100)
    }
    return {
      startDate: dailyRows[startIndex].date,
      endDate: dailyRows[endIndex].date,
      startPrice: startClose,
      endPrice: endClose,
      changePercent: (endClose / startClose - 1) * 100,
      durationDays: period === '30m'
        ? Math.max(0, (Date.parse(`${dailyRows[endIndex].date.replace(' ', 'T').slice(0, 16)}:00Z`) - Date.parse(`${dailyRows[startIndex].date.replace(' ', 'T').slice(0, 16)}:00Z`)) / 86_400_000)
        : Math.max(0, dateOrdinal(dailyRows[endIndex].date) - dateOrdinal(dailyRows[startIndex].date)),
      barCount: endIndex - startIndex + 1,
      maxFallPercent,
      maxRisePercent,
    }
  }

  const phaseSummary = (signal: MarketTrendSignal): MarketTrendPhaseHistory => {
    const completed: MarketTrendHistoricalSegment[] = []
    for (let index = 0; index < events.length - 1; index += 1) {
      const start = events[index]
      const end = events[index + 1]
      if (start.signal === signal && end.signal !== signal && start.index >= 0 && end.index >= 0) {
        const item = segment(start.index, end.index - 1)
        if (item) completed.push(item)
      }
    }
    const lastEvent = events.at(-1)
    const current = lastEvent?.signal === signal && lastEvent.index >= 0 && dailyRows.length > 0
      ? segment(lastEvent.index, dailyRows.length - 1)
      : null
    const observed = current ? [...completed, current] : completed
    const average = (pick: (item: MarketTrendHistoricalSegment) => number) => completed.length
      ? completed.reduce((sum, item) => sum + pick(item), 0) / completed.length
      : null
    return {
      signalCount: events.filter(event => event.signal === signal).length,
      completedCount: completed.length,
      completed,
      averageChangePercent: average(item => item.changePercent),
      averageDurationDays: average(item => item.durationDays),
      averageBarCount: average(item => item.barCount),
      averageMaxFallPercent: average(item => item.maxFallPercent),
      averageMaxRisePercent: average(item => item.maxRisePercent),
      maxFallPercent: observed.length ? Math.min(...observed.map(item => item.maxFallPercent)) : null,
      maxRisePercent: observed.length ? Math.max(...observed.map(item => item.maxRisePercent)) : null,
      current,
    }
  }

  return {
    startDate: signalRows[0]?.date ?? null,
    endDate: signalRows.at(-1)?.date ?? null,
    retreat: phaseSummary('retreat'),
    attack: phaseSummary('attack'),
  }
}

function signalAvailableAt(
  signalDate: string,
  signalPeriod: MarketTrendPeriod,
  chartDate: string,
  chartPeriod: KlinePeriod,
) {
  const signalKey = signalDate.replace('T', ' ')
  const chartKey = chartDate.replace('T', ' ')
  const chartDay = chartKey.slice(0, 10)
  if (chartPeriod === '30m' && chartKey.length >= 16 && chartKey.slice(11, 16) < '15:00' && signalPeriod !== '30m') {
    return signalKey.slice(0, 10) < chartDay
  }
  const cutoff = signalPeriod === '30m' && chartKey.length === 10 ? `${chartKey} 15:00` : chartKey
  const signalTimeKey = signalPeriod === '30m' ? signalKey.slice(0, 16) : signalKey.slice(0, 10)
  const cutoffKey = signalPeriod === '30m' ? cutoff.slice(0, 16) : cutoff.slice(0, 10)
  return signalTimeKey <= cutoffKey
}

/** 对每根图表K线，只使用该时点前已发生的各周期最近交叉信号。 */
export function calculateMarketTrendScoreSeries(
  chartRows: readonly { date: string }[],
  chartPeriod: KlinePeriod,
  history?: MarketTrendHistory,
): (number | null)[] {
  if (!history) return chartRows.map(() => null)
  const events = Object.fromEntries(MARKET_TREND_PERIODS.map(period => [
    period,
    calculateAngelDevil(history[period].map(row => row.close)).flatMap((row, index) => row.signal
      ? [{ date: history[period][index].date, signal: row.signal === 'buy' ? 'attack' as const : 'retreat' as const }]
      : []),
  ])) as Record<MarketTrendPeriod, { date: string; signal: MarketTrendSignal }[]>
  const cursors: Record<MarketTrendPeriod, number> = { '1w': 0, '1d': 0, '30m': 0 }
  const latest: Record<MarketTrendPeriod, MarketTrendSignal | null> = { '1w': null, '1d': null, '30m': null }

  return chartRows.map(bar => {
    for (const period of MARKET_TREND_PERIODS) {
      const periodEvents = events[period]
      while (cursors[period] < periodEvents.length && signalAvailableAt(periodEvents[cursors[period]].date, period, bar.date, chartPeriod)) {
        latest[period] = periodEvents[cursors[period]].signal
        cursors[period] += 1
      }
    }
    return marketTrendAssessment(latest['1w'], latest['1d'], latest['30m'])?.score ?? null
  })
}

export interface MarketTrendAssessment {
  score: number
  scoreCalculation: string
  environment: string
  explanation: string
  usedThirtyMinute: boolean
}

function describeMarketTrend(
  weekly: MarketTrendSignal,
  daily: MarketTrendSignal,
  thirtyMinute: MarketTrendSignal | null,
): Pick<MarketTrendAssessment, 'environment' | 'explanation'> {
  if (!thirtyMinute) {
    if (weekly === 'attack' && daily === 'attack') {
      return { environment: '周日多头共振', explanation: '周线与日线同步进攻' }
    }
    if (weekly === 'attack') {
      return { environment: '周线进攻，日线调整', explanation: '周线进攻、日线撤退，方向出现分歧' }
    }
    if (daily === 'attack') {
      return { environment: '周线撤退，日线反弹', explanation: '周线撤退、日线进攻，方向出现分歧' }
    }
    return { environment: '周日空头共振', explanation: '周线与日线同步撤退' }
  }

  if (weekly === 'attack') {
    if (daily === 'attack') {
      return thirtyMinute === 'attack'
        ? { environment: '强多头共振', explanation: '多头共振，短期同步走强' }
        : { environment: '多头短期调整', explanation: '多头环境中的短期调整' }
    }
    return thirtyMinute === 'attack'
      ? { environment: '多头调整中反弹', explanation: '中期上涨背景下尝试止跌' }
      : { environment: '多头中期调整', explanation: '调整仍在进行' }
  }

  if (daily === 'attack') {
    return thirtyMinute === 'attack'
      ? { environment: '空头环境中反弹', explanation: '空头背景下反弹延续' }
      : { environment: '空头反弹减弱', explanation: '反弹可能减弱' }
  }
  return thirtyMinute === 'attack'
    ? { environment: '空头短期反抽', explanation: '空头环境中的短期反抽' }
    : { environment: '强空头共振', explanation: '三周期空头共振' }
}

export function marketTrendAssessment(
  weekly: MarketTrendSignal | null,
  daily: MarketTrendSignal | null,
  thirtyMinute: MarketTrendSignal | null,
): MarketTrendAssessment | null {
  if (!weekly || !daily) return null
  const signalValue = (signal: MarketTrendSignal) => signal === 'attack' ? 1 : 0
  const thirtyMinuteValue = thirtyMinute ? signalValue(thirtyMinute) : 0.5
  const rawScore = 55 * signalValue(weekly) + 30 * signalValue(daily) + 15 * thirtyMinuteValue
  const score = Math.round(rawScore)
  const signalLabel = (signal: MarketTrendSignal | null) => signal === null
    ? '缺失'
    : signal === 'attack' ? '进攻' : '撤退'
  const signalValueLabel = (signal: MarketTrendSignal | null) => signal === null ? '0.5' : String(signalValue(signal))
  const scoreCalculation = [
    `周线（${signalLabel(weekly)}）55×${signalValueLabel(weekly)}`,
    `日线（${signalLabel(daily)}）30×${signalValueLabel(daily)}`,
    `30F（${signalLabel(thirtyMinute)}）15×${signalValueLabel(thirtyMinute)}`,
  ].join(' + ') + ` = ${rawScore}${rawScore === score ? '' : `，四舍五入为 ${score}`}`

  return {
    score,
    scoreCalculation,
    ...describeMarketTrend(weekly, daily, thirtyMinute),
    usedThirtyMinute: thirtyMinute !== null,
  }
}
