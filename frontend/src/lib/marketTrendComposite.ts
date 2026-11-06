import { calculateMarketTrendScoreSeries, signalAvailableAt, type MarketTrendHistory } from './marketTrend'
import type { KlinePeriod } from './api'
import type { TechnicalScoreRow } from './api'
import type { DowAnalysis } from './dow'

export interface MarketTrendComposite {
  score: number | null
  asOf: string | null
  available: boolean
  factors: { name: string; weight: number; score: number | null; contribution: number | null }[]
  topWarning: boolean
  bottomWarning: boolean
  evidence: string[]
  structure: string
  eventDate: string | null
  levels: { name: string; value: number }[]
}
const valid = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && value >= 0 && value <= 100

/** Inputs must all describe the same closed daily observation. Historical details are never active signals. */
export function assessMarketTrendComposite(original: number | null, daily?: TechnicalScoreRow, dow?: DowAnalysis, asOf: string | null = null): MarketTrendComposite {
  const alignedDaily = daily && daily.as_of === asOf ? daily : undefined
  const alignedDow = dow?.dataThrough?.slice(0, 10) === asOf && dow.status === 'ok' ? dow : undefined
  const categories = alignedDaily?.categories ?? []
  const momentum = categories.find(category => category.id === 'momentum')
  const macd = momentum?.indicators.find(indicator => indicator.id === 'macd')
  const rsi = momentum?.indicators.find(indicator => indicator.id === 'rsi')
  const volume = categories.find(category => category.id === 'volume_price')
  const volumeScore = volume?.available && volume.coverage >= 100 && valid(volume.score) ? volume.score : null
  const macdScore = valid(macd?.score) ? macd.score : null
  const rsiValue = rsi?.raw_values.rsi14
  let rsiScore: number | null = null
  if (valid(rsiValue) && ['RISING', 'FALLING', 'FLAT'].includes(rsi?.direction ?? '')) {
    rsiScore = Math.max(0, Math.min(100, 50 + 0.8 * (rsiValue - 50)
      + (rsi?.direction === 'RISING' ? 10 : rsi?.direction === 'FALLING' ? -10 : 0)
      + (rsi?.divergence === 'BOTTOM_DIVERGENCE' ? 10 : rsi?.divergence === 'TOP_DIVERGENCE' ? -10 : 0)))
  }
  const structureScore = !alignedDow ? null : alignedDow.trend === 'up' ? (alignedDow.damaged ? 40 : 80)
    : alignedDow.trend === 'down' ? (alignedDow.damaged ? 60 : 20) : 50
  const factors = [
    { name: '原市场趋势', weight: 40, score: valid(original) ? original : null },
    { name: '日线价格结构', weight: 20, score: structureScore },
    { name: '日线MACD', weight: 15, score: macdScore },
    { name: '日线RSI', weight: 10, score: rsiScore },
    { name: '日线量价', weight: 15, score: volumeScore },
  ].map(factor => ({ ...factor, contribution: factor.score == null ? null : factor.score * factor.weight / 100 }))
  const topDivergence = [macd, rsi].some(indicator => indicator?.divergence === 'TOP_DIVERGENCE')
  const bottomDivergence = [macd, rsi].some(indicator => indicator?.divergence === 'BOTTOM_DIVERGENCE')
  const weakening = ['BULL_SHRINKING', 'BEAR_EXPANDING'].includes(macd?.momentum ?? '')
  const improving = ['BEAR_SHRINKING', 'BULL_EXPANDING'].includes(macd?.momentum ?? '')
  const topWarning = topDivergence && (weakening || (volumeScore != null && volumeScore < 50))
  const bottomWarning = bottomDivergence && (improving || (volumeScore != null && volumeScore > 50))
  const evidence: string[] = []
  const divergenceDates = (kind: string) => [...new Set([macd, rsi].filter(indicator => indicator?.divergence === kind).map(indicator => indicator?.recent_divergence_as_of).filter(Boolean))].join('、')
  if (topWarning) evidence.push(`当前有效顶背离${divergenceDates('TOP_DIVERGENCE') ? `（确认于${divergenceDates('TOP_DIVERGENCE')}）` : ''}；` + (weakening ? 'MACD动能转弱' : '量价偏弱'))
  if (bottomWarning) evidence.push(`当前有效底背离${divergenceDates('BOTTOM_DIVERGENCE') ? `（确认于${divergenceDates('BOTTOM_DIVERGENCE')}）` : ''}；` + (improving ? 'MACD动能修复' : '量价改善'))
  const confirmation = alignedDow?.basis?.confirmation
  const damage = alignedDow?.events.filter(event => event.kind === 'damage').at(-1)
  const structure = !alignedDow ? '结构数据不足' : alignedDow.damaged
    ? (alignedDow.trend === 'up' ? '上涨结构受损' : '下跌结构受损')
    : confirmation && ['confirm', 'reversal'].includes(confirmation.kind)
      ? (confirmation.direction === 'up' ? '向上结构确认' : '向下结构确认') : '等待结构形成'
  const levels = (alignedDow?.paths ?? []).flatMap(path => path.value != null && Number.isFinite(path.value) && ['damage', 'confirmation'].includes(path.kind)
    ? [{ name: path.kind === 'damage' ? '结构保护价' : path.direction === 'up' ? '向上确认价' : '向下确认价', value: path.value }] : [])
  const available = factors.every(factor => factor.contribution != null)
  return { score: available ? Math.round(factors.reduce((sum, factor) => sum + factor.contribution!, 0)) : null,
    asOf, available, factors, topWarning, bottomWarning, evidence, structure,
    eventDate: (alignedDow?.damaged ? damage?.date : confirmation?.date) ?? null, levels }
}

/** Replay only published pivots/events; the final Dow trend must never be copied into history. */
export function calculateCompositeTrendSeries(rows: readonly { date: string }[], period: KlinePeriod, history?: MarketTrendHistory): (number | null)[] {
  const originals = calculateMarketTrendScoreSeries(rows, period, history)
  if (!history?.dailyScores || !history.dailyDow) return rows.map(() => null)
  const dow = history.dailyDow
  const daily = history.dailyScores
  let cursor = -1
  let eventCursor = 0
  let pivotCursor = 0
  let highs = 0
  let lows = 0
  let trend = 'unknown'
  let damaged = false
  return rows.map((bar, index) => {
    while (cursor + 1 < daily.length && signalAvailableAt(daily[cursor + 1].as_of, '1d', bar.date, period)) cursor++
    if (cursor < 0) return null
    const asOf = daily[cursor].as_of
    while (pivotCursor < dow.pivots.length && dow.pivots[pivotCursor].confirmedAt.slice(0, 10) <= asOf) {
      if (dow.pivots[pivotCursor].side === 'high') highs++
      else lows++
      pivotCursor++
    }
    while (eventCursor < dow.events.length && dow.events[eventCursor].date.slice(0, 10) <= asOf) {
      const event = dow.events[eventCursor++]
      if (event.kind === 'confirm' || event.kind === 'reversal') { trend = event.direction; damaged = false }
      else if (event.kind === 'damage') damaged = true
    }
    const snapshot: DowAnalysis = { ...dow, dataThrough: asOf,
      status: dow.status === 'ok' && highs >= 2 && lows >= 2 ? 'ok' : 'insufficient',
      trend, damaged, basis: undefined, events: [], paths: [] }
    return assessMarketTrendComposite(originals[index], daily[cursor], snapshot, asOf).score
  })
}
