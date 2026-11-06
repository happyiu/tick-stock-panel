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

/** Smooth directional MACD score; scale by ATR so prices and volatility are comparable. */
export function continuousMacdScore(daily?: TechnicalScoreRow): number | null {
  const raw = daily?.categories?.find(c => c.id === 'momentum')?.indicators.find(i => i.id === 'macd')?.raw_values
  const atr = daily?.categories?.find(c => c.id === 'price_position')?.indicators.find(i => i.id === 'ma20_atr_position')?.raw_values.atr14
  if (!raw || atr == null || !Number.isFinite(atr) || atr <= 0) return null
  const { dif, hist, previous_hist: previous } = raw
  if ([dif, hist, previous].some(value => value == null || !Number.isFinite(value))) return null
  return 50 + 50 * (0.5 * Math.tanh(2 * hist! / atr)
    + 0.3 * Math.tanh(dif! / atr) + 0.2 * Math.tanh(8 * (hist! - previous!) / atr))
}

export function calculateTrendSpeedSeries(rows: readonly { date: string }[], period: KlinePeriod, history?: MarketTrendHistory) {
  const daily = history?.dailyScores ?? []
  const values = daily.map(row => row.categories?.find(c => c.id === 'price_position')?.indicators.find(i => i.id === 'ma20_atr_position')?.raw_values)
  const speeds = values.map((raw, index) => {
    const close = raw?.close, previous = values[index - 5]?.close, atr = raw?.atr14
    return close != null && previous != null && atr != null && [close, previous, atr].every(Number.isFinite) && close > 0 && previous > 0 && atr > 0
      ? (close - previous) / (5 * atr) : null
  })
  let cursor = -1
  return rows.map(bar => {
    while (cursor + 1 < daily.length && signalAvailableAt(daily[cursor + 1].as_of, '1d', bar.date, period)) cursor++
    const speed = speeds[cursor] ?? null, previous = speeds[cursor - 3] ?? null
    return { speed, speedChange: speed != null && previous != null ? speed - previous : null }
  })
}

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
  const macdScore = continuousMacdScore(alignedDaily)
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

export type TurningRegion = -1 | 0 | 1 | null // bottom / none / top / unavailable
export function identifyTurningRegion(position60: number | null, scoreChange: number | null, speed: number | null, speedChange: number | null): TurningRegion {
  if (!valid(position60) || [scoreChange, speed, speedChange].some(value => value == null || !Number.isFinite(value))) return null
  if (position60 <= 20 && speed! < 0 && scoreChange! >= 2 && speedChange! >= 0.05) return -1
  if (position60 >= 80 && speed! > 0 && scoreChange! <= -2 && speedChange! <= -0.05) return 1
  return 0
}

/** Daily observation areas are published at the close, never moved back to earlier lows/highs. */
export function calculateTurningRegionSeries(rows: readonly { date: string }[], period: KlinePeriod, history?: MarketTrendHistory) {
  const daily = history?.dailyScores ?? []
  const dates = daily.map(row => ({ date: row.as_of }))
  const scores = calculateCompositeTrendSeries(dates, '1d', history)
  const speeds = calculateTrendSpeedSeries(dates, '1d', history)
  const areas = daily.map((row, i) => {
    const rawPosition = row.categories?.find(c => c.id === 'price_position')?.indicators.find(indicator => indicator.id === 'range_position_60')?.value
    const position60 = valid(rawPosition) ? rawPosition : null
    const scoreChange3 = scores[i] != null && scores[i - 3] != null ? scores[i]! - scores[i - 3]! : null
    return { region: identifyTurningRegion(position60, scoreChange3, speeds[i].speed, speeds[i].speedChange), position60, scoreChange3, regionDay: Number(row.as_of.slice(0, 10).replaceAll('-', '')) }
  })
  let cursor = -1
  return rows.map(bar => {
    while (cursor + 1 < daily.length && signalAvailableAt(daily[cursor + 1].as_of, '1d', bar.date, period)) cursor++
    return areas[cursor] ?? { region: null, position60: null, scoreChange3: null, regionDay: null }
  })
}
