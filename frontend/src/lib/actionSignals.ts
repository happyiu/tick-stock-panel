import type { ChanlunBarInput } from './chanlun.ts'
import type { ChartDataStatus, KlinePeriod, TechnicalScoreRow, TechnicalScores } from './api.ts'

export const ACTION_SIGNAL_VERSION = 'action-signal-v3' as const
export const ACTION_SIGNAL_WARMUP_BARS = 60

const OBSERVATION_MAX_AGE = 25
const STRUCTURE_LOOKBACK = 40
const PIVOT_SPAN = 2
const ACTION_COOLDOWN_BARS = 5
const ROC_HISTORY_LOOKBACK = 250
const ROC_HISTORY_MIN_SAMPLES = 30
const ROC_HISTORY_FLAT_BAND = 0.0005
const BOTTOM_MA20_ATR_THRESHOLD = -1.2
const BOTTOM_ROC20_PERCENTILE_THRESHOLD = 15

export type ActionSignalType = 'attack' | 'add' | 'reduce' | 'retreat'
export type ActionPhase = 'wait' | 'bullish' | 'defensive'
export type ActionCurrentAction = ActionSignalType | 'bottom_observe' | 'top_observe' | 'extreme_top_observe' | 'hold' | 'defensive' | 'wait' | 'wait_defensive'
export type ActionSignalStatus = 'ready' | 'provisional' | 'blocked' | 'stale'
export type ActionSignalTrigger = 'breakout' | 'pullback' | 'structure' | 'support_break' | 'score_decay' | 'core_invalidation' | 'exhaustion' | 'neckline_break'

export interface ActionBar extends ChanlunBarInput {
  volume?: number | null
  boll_upper?: number | null
  boll_lower?: number | null
  rsi_14?: number | null
}

export interface ActionScore {
  date: string
  direction: number | null
  trend: number | null
  momentum: number | null
  volumePrice: number | null
  available: boolean
  source?: 'technical-score-v1' | 'technical-score-v2' | 'technical-score-v3' | 'technical-score-v4' | 'technical-score-v5' | 'technical-score-v6' | 'technical-score-v7' | 'technical-score-v8'
}

export interface ActionSignalEvent {
  id: string
  type: ActionSignalType
  period: KlinePeriod
  date: string
  confirmedAt: string
  score: ActionScore
  trigger: ActionSignalTrigger
  referencePrice: number | null
  invalidationPrice: number | null
  structureSignalId: string | null
  structureMode: 'structure_proxy' | 'price_event'
  reasons: string[]
}

export interface ActionSignalState {
  date: string | null
  phase: ActionPhase
  action: ActionCurrentAction
  score: ActionScore | null
  defensePrice: number | null
  eventId: string | null
}

export interface ActionSignalResult {
  version: typeof ACTION_SIGNAL_VERSION
  symbol: string | null
  assetType: 'stock' | 'etf' | 'index' | null
  period: KlinePeriod
  status: ActionSignalStatus
  reason: string
  dataStatus: ActionSignalStatus
  window: {
    start: string | null
    end: string | null
    bars: number
    closedBars: number
  }
  analysisStartDate: string | null
  latestClosedDate: string | null
  current: ActionSignalState
  currentEvent: ActionSignalEvent | null
  events: ActionSignalEvent[]
  history: ActionSignalState[]
  pendingConfirmation: boolean
  nextConditions: string[]
  riskConditions: string[]
}

export interface ActionSignalInput {
  symbol?: string
  assetType?: 'stock' | 'etf' | 'index'
  period: KlinePeriod
  rows: ActionBar[]
  /** 可选，仅作为事件快照中的辅助信息，不参与行动信号门控。 */
  technicalScores?: TechnicalScores
  dataStatus?: ChartDataStatus
  /** enriched 是图表源不可用时仍可用的本地规范数据，不阻断行动信号回放。 */
  dataSource?: string
  selectedDate?: string | null
}

export interface ActionSignalComparison {
  status: 'aligned' | 'divergent' | 'unavailable'
  text: string
  period: KlinePeriod
}

interface ActionFeatures {
  atr: number | null
  ma20: number | null
  bollUpper: number | null
  bollLower: number | null
  rsi: number | null
  macdHist: number | null
  roc5: number | null
  roc20: number | null
  roc20Percentile: number | null
  position20: number | null
  rangeRatio: number | null
  volumeRatio: number | null
}

interface HigherLowStructure {
  previousIndex: number
  latestIndex: number
  previousLow: number
  latestLow: number
  key: string
  neckline: number | null
  necklineBreak: boolean
}

interface ReplayState {
  phase: ActionPhase
  defensePrice: number | null
  events: ActionSignalEvent[]
  history: ActionSignalState[]
  usedStructureKeys: Set<string>
  reducedInRound: boolean
  lastActionIndex: number
  lastEventId: string | null
  bottomObservedAt: number | null
  topObservedAt: number | null
  extremeTopObservedAt: number | null
  topNeutralStreak: number
  breakBelowDefenseStreak: number
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0
}

function normalizeKey(value: string | null | undefined, period: KlinePeriod): string {
  if (!value) return ''
  const normalized = value.replace('T', ' ')
  return period === '30m' ? normalized.slice(0, 16) : normalized.slice(0, 10)
}

function scoreFor(scoreMap: Map<string, ActionScore>, bar: ActionBar, period: KlinePeriod): ActionScore {
  return scoreMap.get(normalizeKey(bar.date, period)) ?? {
    date: bar.date,
    direction: null,
    trend: null,
    momentum: null,
    volumePrice: null,
    available: false,
  }
}

function scoreFromRow(row: TechnicalScoreRow, period: KlinePeriod): ActionScore {
  return {
    date: normalizeKey(row.as_of, period),
    direction: finite(row.direction_score) ? row.direction_score : null,
    trend: finite(row.trend) ? row.trend : null,
    momentum: finite(row.momentum) ? row.momentum : null,
    volumePrice: finite(row.volume_price) ? row.volume_price : null,
    available: row.available === true,
    source: 'technical-score-v8',
  }
}

function buildScoreMap(scores: TechnicalScores | undefined, period: KlinePeriod): Map<string, ActionScore> {
  const map = new Map<string, ActionScore>()
  for (const row of scores?.rows ?? []) map.set(normalizeKey(row.as_of, period), scoreFromRow(row, period))
  return map
}

function buildRoc20PercentileMap(scores: TechnicalScores | undefined): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of scores?.rows ?? []) {
    const roc = row.categories
      ?.find(category => category.id === 'momentum')
      ?.indicators
      .find(indicator => indicator.id === 'roc')
      ?.periods
      ?.find(period => period.period === 20)
    if (finite(roc?.percentile)) map.set(normalizeKey(row.as_of, '30m'), roc.percentile)
  }
  return map
}

function scoreReady(score: ActionScore): boolean {
  return score.available && [score.direction, score.trend, score.momentum, score.volumePrice].every(finite)
}

function scoreText(score: ActionScore): string {
  const values = [score.direction, score.trend, score.momentum, score.volumePrice]
  return values.every(finite)
    ? `方向${Math.round(score.direction!)} / 趋势${Math.round(score.trend!)} / 动能${Math.round(score.momentum!)} / 量价${Math.round(score.volumePrice!)}`
    : '技术评分未参与行动判定'
}

function auxiliaryScoreReason(score: ActionScore): string[] {
  return scoreReady(score) ? [`辅助技术评分（不作门槛）：${scoreText(score)}`] : []
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function rocAt(bars: ActionBar[], index: number, lookback: number): number | null {
  const base = bars[index - lookback]?.close
  return positive(base) ? bars[index].close / base - 1 : null
}

function fallbackRoc20Percentile(bars: ActionBar[], index: number, current: number | null): number | null {
  if (current == null) return null
  const values: number[] = []
  for (let cursor = Math.max(0, index - ROC_HISTORY_LOOKBACK + 1); cursor <= index; cursor += 1) {
    const value = rocAt(bars, cursor, 20)
    if (value != null) values.push(value)
  }
  if (values.length < ROC_HISTORY_MIN_SAMPLES) return null
  const low = Math.min(...values)
  const high = Math.max(...values)
  if (high - low <= ROC_HISTORY_FLAT_BAND) return null
  const less = values.filter(value => value < current).length
  const equal = values.filter(value => value === current).length
  return (less + equal * 0.5) / values.length * 100
}

function fallbackAtr(bars: ActionBar[], index: number): number | null {
  const ranges: number[] = []
  for (let cursor = Math.max(1, index - 13); cursor <= index; cursor += 1) {
    const current = bars[cursor]
    const previous = bars[cursor - 1]
    if (!current || !previous) continue
    const range = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    )
    if (positive(range)) ranges.push(range)
  }
  return average(ranges)
}

function fallbackMa20(bars: ActionBar[], index: number): number | null {
  return average(bars.slice(Math.max(0, index - 19), index + 1).map(bar => bar.close).filter(positive))
}

function featureAt(bars: ActionBar[], index: number, roc20Percentiles?: Map<string, number>): ActionFeatures {
  const bar = bars[index]
  const atr = positive(bar.atr14) ? bar.atr14 : fallbackAtr(bars, index)
  const ma20 = positive(bar.ma20) ? bar.ma20 : fallbackMa20(bars, index)
  const positionWindow = bars.slice(Math.max(0, index - 19), index + 1)
  const high = Math.max(...positionWindow.map(item => item.high))
  const low = Math.min(...positionWindow.map(item => item.low))
  const position20 = positionWindow.length >= 5 && high > low ? (bar.close - low) / (high - low) : null
  const priorVolume = average(bars.slice(Math.max(0, index - 5), index).map(item => item.volume ?? 0).filter(positive))
  const volumeRatio = positive(bar.volume) && positive(priorVolume) ? bar.volume / priorVolume : null
  const roc5 = rocAt(bars, index, 5)
  const roc20 = rocAt(bars, index, 20)
  return {
    atr,
    ma20,
    bollUpper: positive(bar.boll_upper) ? bar.boll_upper : null,
    bollLower: positive(bar.boll_lower) ? bar.boll_lower : null,
    rsi: finite(bar.rsi_14) ? bar.rsi_14 : null,
    macdHist: finite(bar.macd_hist) ? bar.macd_hist : finite(bar.macdHist) ? bar.macdHist : null,
    roc5,
    roc20,
    roc20Percentile: roc20Percentiles?.get(normalizeKey(bar.date, '30m')) ?? fallbackRoc20Percentile(bars, index, roc20),
    position20,
    rangeRatio: positive(atr) ? (bar.high - bar.low) / atr : null,
    volumeRatio,
  }
}

function countTrue(values: boolean[]): number {
  return values.filter(Boolean).length
}

function isBottomObservation(features: ActionFeatures, close: number): boolean {
  const distance = finite(features.ma20) && positive(features.atr) ? (close - features.ma20!) / features.atr! : null
  const locationCount = countTrue([
    distance != null && distance <= BOTTOM_MA20_ATR_THRESHOLD,
    features.position20 != null && features.position20 <= 0.2,
    features.bollLower != null && positive(features.atr) && close <= features.bollLower + features.atr * 0.2,
  ])
  const momentumCount = countTrue([
    features.rsi != null && features.rsi <= 35,
    features.roc20Percentile != null && features.roc20Percentile <= BOTTOM_ROC20_PERCENTILE_THRESHOLD,
  ])
  return locationCount >= 1 && momentumCount >= 1
}

function isTopObservation(features: ActionFeatures, close: number): boolean {
  const distance = finite(features.ma20) && positive(features.atr) ? (close - features.ma20!) / features.atr! : null
  const locationCount = countTrue([
    distance != null && distance >= 1.2,
    features.position20 != null && features.position20 >= 0.85,
    features.bollUpper != null && positive(features.atr) && close >= features.bollUpper - features.atr * 0.2,
  ])
  const momentumCount = countTrue([
    features.rsi != null && features.rsi >= 68,
    features.roc20Percentile != null && features.roc20Percentile >= 85,
  ])
  return locationCount >= 1 && momentumCount >= 1
}

function isExtremeTopObservation(features: ActionFeatures, close: number): boolean {
  const distance = finite(features.ma20) && positive(features.atr) ? (close - features.ma20!) / features.atr! : null
  return (distance != null && distance >= 2)
    || (features.position20 != null && features.position20 >= 0.97 && features.rsi != null && features.rsi >= 75)
    || (features.roc20Percentile != null && features.roc20Percentile >= 95 && features.rsi != null && features.rsi >= 75)
}

function isTopNeutral(features: ActionFeatures, close: number): boolean {
  const distance = finite(features.ma20) && positive(features.atr) ? (close - features.ma20!) / features.atr! : null
  return features.rsi != null && features.rsi < 58
    && features.position20 != null && features.position20 < 0.65
    && distance != null && distance < 0.5
}

function isBullishReversal(bars: ActionBar[], index: number): boolean {
  const bar = bars[index]
  const previous = bars[index - 1]
  if (!bar || !previous) return false
  const range = bar.high - bar.low
  return bar.close >= bar.open && bar.close > previous.close && (range <= 0 || bar.close >= bar.low + range * 0.55)
}

function isBearishReversal(bars: ActionBar[], index: number): boolean {
  const bar = bars[index]
  const previous = bars[index - 1]
  if (!bar || !previous) return false
  const range = bar.high - bar.low
  return bar.close <= bar.open && bar.close < previous.close && (range <= 0 || bar.close <= bar.high - range * 0.55)
}

function confirmedPivotIndices(bars: ActionBar[], index: number, type: 'bottom' | 'top'): number[] {
  const result: number[] = []
  const from = Math.max(PIVOT_SPAN, index - STRUCTURE_LOOKBACK)
  const to = index - PIVOT_SPAN
  for (let pivotIndex = from; pivotIndex <= to; pivotIndex += 1) {
    const pivot = bars[pivotIndex]
    const value = type === 'bottom' ? pivot.low : pivot.high
    const left = bars.slice(pivotIndex - PIVOT_SPAN, pivotIndex)
    const right = bars.slice(pivotIndex + 1, pivotIndex + PIVOT_SPAN + 1)
    const neighbors = [...left, ...right]
    const better = type === 'bottom'
      ? neighbors.every(item => value <= item.low)
      : neighbors.every(item => value >= item.high)
    const strict = type === 'bottom'
      ? neighbors.some(item => value < item.low)
      : neighbors.some(item => value > item.high)
    if (better && strict) result.push(pivotIndex)
  }
  return result
}

function lowerLowAt(bars: ActionBar[], index: number): boolean {
  const prior = bars.slice(Math.max(0, index - 5), index).map(bar => bar.low)
  return prior.length >= 3 && bars[index].low <= Math.min(...prior)
}

function higherHighAt(bars: ActionBar[], index: number): boolean {
  const prior = bars.slice(Math.max(0, index - 5), index).map(bar => bar.high)
  return prior.length >= 3 && bars[index].high >= Math.max(...prior)
}

function bottomExhaustion(bars: ActionBar[], index: number, current: ActionFeatures, roc20Percentiles?: Map<string, number>): boolean {
  if (index < 3 || !isBullishReversal(bars, index)) return false
  const pivots = confirmedPivotIndices(bars, index, 'bottom')
  for (const pivotIndex of pivots.slice(-3).reverse()) {
    if (index - pivotIndex < 2 || index - pivotIndex > 8 || !lowerLowAt(bars, pivotIndex)) continue
    const pivot = featureAt(bars, pivotIndex, roc20Percentiles)
    const before = featureAt(bars, pivotIndex - 1, roc20Percentiles)
    const improved = countTrue([
      pivot.rsi != null && before.rsi != null && (pivot.rsi > before.rsi + 1 || (current.rsi != null && current.rsi > pivot.rsi + 1)),
      pivot.roc5 != null && before.roc5 != null && (pivot.roc5 > before.roc5 || (current.roc5 != null && current.roc5 > pivot.roc5)),
      pivot.roc20 != null && before.roc20 != null && (pivot.roc20 > before.roc20 || (current.roc20 != null && current.roc20 > pivot.roc20)),
      pivot.macdHist != null && before.macdHist != null && (pivot.macdHist > before.macdHist || (current.macdHist != null && current.macdHist > pivot.macdHist)),
      pivot.rangeRatio != null && current.rangeRatio != null && current.rangeRatio < pivot.rangeRatio,
      pivot.volumeRatio != null && current.volumeRatio != null && current.volumeRatio > pivot.volumeRatio,
    ]) >= 2
    if (improved) return true
  }
  return false
}

function topExhaustion(bars: ActionBar[], index: number, current: ActionFeatures, roc20Percentiles?: Map<string, number>): boolean {
  if (index < 3 || !isBearishReversal(bars, index)) return false
  const pivots = confirmedPivotIndices(bars, index, 'top')
  for (const pivotIndex of pivots.slice(-3).reverse()) {
    if (index - pivotIndex < 2 || index - pivotIndex > 8 || !higherHighAt(bars, pivotIndex)) continue
    const pivot = featureAt(bars, pivotIndex, roc20Percentiles)
    const before = featureAt(bars, pivotIndex - 1, roc20Percentiles)
    const weakened = countTrue([
      pivot.rsi != null && before.rsi != null && (pivot.rsi < before.rsi - 1 || (current.rsi != null && current.rsi < pivot.rsi - 1)),
      pivot.roc5 != null && before.roc5 != null && (pivot.roc5 < before.roc5 || (current.roc5 != null && current.roc5 < pivot.roc5)),
      pivot.roc20 != null && before.roc20 != null && (pivot.roc20 < before.roc20 || (current.roc20 != null && current.roc20 < pivot.roc20)),
      pivot.macdHist != null && before.macdHist != null && (pivot.macdHist < before.macdHist || (current.macdHist != null && current.macdHist < pivot.macdHist)),
      pivot.rangeRatio != null && current.rangeRatio != null && current.rangeRatio < pivot.rangeRatio,
      pivot.volumeRatio != null && current.volumeRatio != null && current.volumeRatio <= pivot.volumeRatio,
    ]) >= 2
    if (weakened) return true
  }
  return false
}

function higherLowStructure(bars: ActionBar[], index: number, features: ActionFeatures): HigherLowStructure | null {
  const pivots = confirmedPivotIndices(bars, index, 'bottom')
  if (pivots.length < 2) return null
  const latestIndex = pivots.at(-1)!
  const previousIndex = pivots.at(-2)!
  const latestLow = bars[latestIndex].low
  const previousLow = bars[previousIndex].low
  const tolerance = Math.max((features.atr ?? latestLow * 0.005) * 0.1, latestLow * 0.001)
  if (latestLow <= previousLow + tolerance) return null
  const necklineValues = bars.slice(latestIndex + 1, index).map(bar => bar.high).filter(positive)
  const neckline = necklineValues.length ? Math.max(...necklineValues) : null
  return {
    previousIndex,
    latestIndex,
    previousLow,
    latestLow,
    key: `${previousIndex}:${latestIndex}`,
    neckline,
    necklineBreak: neckline != null && positive(features.atr) && bars[index].close > neckline + features.atr * 0.1,
  }
}

function entryTooExtended(features: ActionFeatures, close: number): boolean {
  const distance = finite(features.ma20) && positive(features.atr) ? (close - features.ma20!) / features.atr! : null
  return (distance != null && distance > 0.9)
    || (features.position20 != null && features.position20 > 0.78)
    || (features.bollUpper != null && positive(features.atr) && close >= features.bollUpper - features.atr * 0.1)
}

function defenseFor(structure: HigherLowStructure, features: ActionFeatures): number {
  const buffer = positive(features.atr) ? features.atr * 0.15 : structure.latestLow * 0.002
  return structure.latestLow - buffer
}

function validDefense(value: number | null, close: number): value is number {
  return positive(value) && value < close
}

function percent(value: number | null): string {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`
}

function locationReasons(features: ActionFeatures, close: number): string[] {
  const distance = finite(features.ma20) && positive(features.atr) ? (close - features.ma20!) / features.atr! : null
  return [
    distance != null ? `MA20/ATR ${distance.toFixed(1)}` : null,
    features.position20 != null ? `20根位置 ${(features.position20 * 100).toFixed(0)}%` : null,
    features.roc20 != null
      ? `ROC20 ${percent(features.roc20)}${features.roc20Percentile != null ? `（历史分位 ${features.roc20Percentile.toFixed(0)}%）` : ''}`
      : null,
    features.rsi != null ? `RSI14 ${features.rsi.toFixed(0)}` : null,
    features.volumeRatio != null ? `量比 ${features.volumeRatio.toFixed(1)}` : null,
  ].filter((item): item is string => item != null)
}

function createEvent(
  type: ActionSignalType,
  trigger: ActionSignalTrigger,
  period: KlinePeriod,
  bar: ActionBar,
  score: ActionScore,
  referencePrice: number | null,
  invalidationPrice: number | null,
  structureId: string | null,
  reasons: string[],
): ActionSignalEvent {
  return {
    id: `${type}:${bar.date}:${trigger}:${structureId ?? ''}`,
    type,
    period,
    date: bar.date,
    confirmedAt: bar.date,
    score,
    trigger,
    referencePrice,
    invalidationPrice,
    structureSignalId: structureId,
    structureMode: 'price_event',
    reasons,
  }
}

function actionForState(state: ReplayState): ActionCurrentAction {
  if (state.phase === 'bullish') return 'hold'
  if (state.phase === 'defensive') {
    if (state.bottomObservedAt != null) return 'bottom_observe'
    if (state.extremeTopObservedAt != null) return 'extreme_top_observe'
    return state.topObservedAt != null ? 'top_observe' : 'defensive'
  }
  if (state.bottomObservedAt != null) return 'bottom_observe'
  if (state.extremeTopObservedAt != null) return 'extreme_top_observe'
  return state.topObservedAt != null ? 'top_observe' : 'wait'
}

function cloneScore(score: ActionScore): ActionScore {
  return { ...score }
}

function historyState(state: ReplayState, bar: ActionBar, score: ActionScore, event?: ActionSignalEvent): ActionSignalState {
  return {
    date: bar.date,
    phase: state.phase,
    action: event?.type ?? actionForState(state),
    score: cloneScore(score),
    defensePrice: state.defensePrice,
    eventId: event?.id ?? state.lastEventId,
  }
}

function emptyResult(
  period: KlinePeriod,
  status: ActionSignalStatus,
  reason: string,
  dataStatus = status,
  context: Pick<ActionSignalInput, 'symbol' | 'assetType'> = {},
): ActionSignalResult {
  return {
    version: ACTION_SIGNAL_VERSION,
    symbol: context.symbol ?? null,
    assetType: context.assetType ?? null,
    period,
    status,
    dataStatus,
    window: { start: null, end: null, bars: 0, closedBars: 0 },
    reason,
    analysisStartDate: null,
    latestClosedDate: null,
    current: { date: null, phase: 'wait', action: 'wait', score: null, defensePrice: null, eventId: null },
    currentEvent: null,
    events: [],
    history: [],
    pendingConfirmation: false,
    nextConditions: ['超跌只进入底部观察；出现动能衰竭、底分型和低点抬高后才试仓', '突破抬高低点后的颈线才加仓'],
    riskConditions: ['高位动能衰竭先减仓', '连续收盘跌破核心防守位且反抽失败后退出'],
  }
}

function nextConditions(phase: ActionPhase): string[] {
  if (phase === 'wait') return ['底部观察 → 动能衰竭 + 底分型 + 低点抬高 → 试仓', '试仓后收盘突破颈线 → 加仓']
  if (phase === 'defensive') return ['重新出现低点抬高和颈线突破后再加仓', '跌破核心防守位并反抽失败 → 退出']
  return ['高位出现顶分型和动能衰竭 → 减仓', '跌破抬高低点防守位，二次确认反抽失败 → 退出']
}

function riskConditions(phase: ActionPhase, defensePrice: number | null): string[] {
  if (defensePrice != null) return [`收盘跌破核心防守位 ${defensePrice.toFixed(3)}，连续确认并反抽失败 → 退出`, '高位扩张后动能衰竭 → 减仓']
  if (phase === 'wait') return ['尚未建立仓位；超跌阶段只观察，不追涨杀跌']
  return ['核心防守位暂不可用，暂不确认退出']
}

function selectStateAt(
  stateHistory: ActionSignalState[],
  events: ActionSignalEvent[],
  selectedDate: string | null | undefined,
  period: KlinePeriod,
): { state: ActionSignalState; event: ActionSignalEvent | null } {
  const target = selectedDate ? normalizeKey(selectedDate, period) : null
  const states = target ? stateHistory.filter(item => item.date && normalizeKey(item.date, period) <= target) : stateHistory
  const state = states.at(-1) ?? { date: null, phase: 'wait', action: 'wait', score: null, defensePrice: null, eventId: null }
  const event = events.filter(item => !target || normalizeKey(item.date, period) <= target).at(-1) ?? null
  return { state, event }
}

/**
 * 按闭合 K 线顺序回放行动信号。
 * 股票和 ETF 共用同一套规则；技术评分只保留在事件快照中，不作为买卖门槛。
 */
export function buildActionSignals({ symbol, assetType, period, rows, technicalScores, dataStatus, dataSource, selectedDate }: ActionSignalInput): ActionSignalResult {
  const context = { symbol, assetType }
  const stale = dataStatus?.stale === true && dataSource !== 'enriched'
  if (!rows.length) return emptyResult(period, 'blocked', '当前周期没有 K 线数据', undefined, context)
  const closedBars = rows.filter(row => row.isClosed === true)
  if (closedBars.length < ACTION_SIGNAL_WARMUP_BARS) {
    const result = emptyResult(period, 'blocked', `当前只有 ${closedBars.length} 根闭合 K 线，至少需要 ${ACTION_SIGNAL_WARMUP_BARS} 根`, undefined, context)
    result.window = {
      start: rows.at(0)?.date ?? null,
      end: rows.at(-1)?.date ?? null,
      bars: rows.length,
      closedBars: closedBars.length,
    }
    result.pendingConfirmation = rows.at(-1)?.isClosed !== true
    return result
  }

  const scoreMap = buildScoreMap(technicalScores, period)
  const roc20Percentiles = buildRoc20PercentileMap(technicalScores)
  const state: ReplayState = {
    phase: 'wait',
    defensePrice: null,
    events: [],
    history: [],
    usedStructureKeys: new Set(),
    reducedInRound: false,
    lastActionIndex: -Infinity,
    lastEventId: null,
    bottomObservedAt: null,
    topObservedAt: null,
    extremeTopObservedAt: null,
    topNeutralStreak: 0,
    breakBelowDefenseStreak: 0,
  }
  let analysisStartDate: string | null = null

  for (let index = 0; index < closedBars.length; index += 1) {
    const bar = closedBars[index]
    const previous = closedBars[index - 1] ?? null
    const score = scoreFor(scoreMap, bar, period)
    const features = featureAt(closedBars, index, roc20Percentiles)
    const lowerExhaustion = bottomExhaustion(closedBars, index, features, roc20Percentiles)
    const upperExhaustion = topExhaustion(closedBars, index, features, roc20Percentiles)
    const bottomObservation = isBottomObservation(features, bar.close) || lowerExhaustion
    const topObservation = isTopObservation(features, bar.close)
    const extremeTopObservation = isExtremeTopObservation(features, bar.close)
    const topWatch = topObservation || extremeTopObservation

    if (bottomObservation) state.bottomObservedAt ??= index
    if (state.bottomObservedAt != null && index - state.bottomObservedAt > OBSERVATION_MAX_AGE) state.bottomObservedAt = null
    if (topWatch) {
      // 只要高位证据再次出现，就刷新观察起点；25 根是兜底期限，不是强制过期点。
      state.topObservedAt = index
      state.topNeutralStreak = 0
    } else if (state.topObservedAt != null) {
      state.topNeutralStreak = isTopNeutral(features, bar.close) ? state.topNeutralStreak + 1 : 0
      if (state.topNeutralStreak >= 3 || index - state.topObservedAt > OBSERVATION_MAX_AGE) {
        state.topObservedAt = null
        state.topNeutralStreak = 0
      }
    }
    if (extremeTopObservation) state.extremeTopObservedAt = index
    if (state.extremeTopObservedAt != null && (index - state.extremeTopObservedAt > OBSERVATION_MAX_AGE || state.topObservedAt == null)) {
      state.extremeTopObservedAt = null
    }
    // 底部观察与高位观察互斥；新一轮下跌不能继续沿用旧的顶部状态。
    if (bottomObservation && !topWatch) {
      state.topObservedAt = null
      state.extremeTopObservedAt = null
      state.topNeutralStreak = 0
    }
    if (topWatch && !bottomObservation) state.bottomObservedAt = null
    if (index < ACTION_SIGNAL_WARMUP_BARS - 1) continue
    analysisStartDate ??= bar.date

    if (state.phase !== 'wait' && validDefense(state.defensePrice, bar.close)) {
      state.breakBelowDefenseStreak = 0
    } else if (state.phase !== 'wait' && positive(state.defensePrice) && bar.close < state.defensePrice) {
      state.breakBelowDefenseStreak += 1
    } else {
      state.breakBelowDefenseStreak = 0
    }

    const structure = higherLowStructure(closedBars, index, features)
    const defenseCandidate = structure ? defenseFor(structure, features) : null
    const bottomObservationFresh = state.bottomObservedAt != null && index - state.bottomObservedAt <= OBSERVATION_MAX_AGE
    const topObservationFresh = state.topObservedAt != null && index - state.topObservedAt <= OBSERVATION_MAX_AGE
    const addCooldownReady = index - state.lastActionIndex >= ACTION_COOLDOWN_BARS
    const coreInvalidation = state.phase !== 'wait'
      && state.breakBelowDefenseStreak >= 2
      && previous != null
      && bar.close >= previous.close
      && positive(state.defensePrice)
      && bar.close < state.defensePrice
    const structureBreak = state.phase !== 'wait'
      && structure != null
      && structure.necklineBreak
      && !state.usedStructureKeys.has(structure.key)
      && !entryTooExtended(features, bar.close)
    const trialEntry = state.phase !== 'bullish'
      && bottomObservationFresh
      && lowerExhaustion
      && isBullishReversal(closedBars, index)
      && structure != null
      && defenseCandidate != null
      && validDefense(defenseCandidate, bar.close)
      && !entryTooExtended(features, bar.close)

    let event: ActionSignalEvent | undefined
    if (!stale && coreInvalidation) {
      event = createEvent('retreat', 'core_invalidation', period, bar, score, state.defensePrice, state.defensePrice, null, [
        `连续收盘跌破核心防守位 ${state.defensePrice!.toFixed(3)}`,
        '反抽仍未收回，确认上涨结构失效',
        ...auxiliaryScoreReason(score),
      ])
      state.phase = 'wait'
      state.defensePrice = null
      state.reducedInRound = false
      state.lastActionIndex = index
      state.lastEventId = event.id
      state.bottomObservedAt = null
      state.topObservedAt = null
      state.extremeTopObservedAt = null
      state.topNeutralStreak = 0
      state.breakBelowDefenseStreak = 0
    } else if (!stale && state.phase === 'bullish' && !state.reducedInRound && topObservationFresh && upperExhaustion) {
      event = createEvent('reduce', 'exhaustion', period, bar, score, bar.close, state.defensePrice, null, [
        '高位扩张后出现顶分型/回落确认',
        '价格仍在高位，但 ROC、RSI、MACD 柱中至少两项出现衰竭',
        ...locationReasons(features, bar.close),
        ...auxiliaryScoreReason(score),
      ])
      state.phase = 'defensive'
      state.reducedInRound = true
      state.lastActionIndex = index
      state.lastEventId = event.id
      state.bottomObservedAt = null
      state.topObservedAt = null
      state.extremeTopObservedAt = null
      state.topNeutralStreak = 0
    } else if (!stale && structureBreak && addCooldownReady && structure && defenseCandidate != null) {
      event = createEvent('add', 'neckline_break', period, bar, score, structure.neckline, state.defensePrice, structure.key, [
        `低点抬高后收盘突破颈线 ${structure.neckline!.toFixed(3)}`,
        '结构由低点抬高进一步确认高点突破，允许加仓',
        ...auxiliaryScoreReason(score),
      ])
      state.phase = 'bullish'
      state.defensePrice = validDefense(defenseCandidate, bar.close) ? defenseCandidate : state.defensePrice
      state.reducedInRound = false
      state.lastActionIndex = index
      state.lastEventId = event.id
      state.usedStructureKeys.add(structure.key)
      state.bottomObservedAt = null
      state.topObservedAt = null
      state.extremeTopObservedAt = null
      state.topNeutralStreak = 0
      state.breakBelowDefenseStreak = 0
    } else if (!stale && trialEntry && addCooldownReady && structure && defenseCandidate != null) {
      const type: ActionSignalType = state.phase === 'wait' ? 'attack' : 'add'
      event = createEvent(type, 'structure', period, bar, score, structure.latestLow, defenseCandidate, structure.key, [
        type === 'attack' ? '超跌后空头动能衰竭，底分型确认低点抬高，试仓' : '新的低点抬高结构确认，回到加仓候选',
        ...locationReasons(features, bar.close),
        `核心防守位 ${defenseCandidate.toFixed(3)}`,
        ...auxiliaryScoreReason(score),
      ])
      state.phase = 'bullish'
      state.defensePrice = defenseCandidate
      state.reducedInRound = false
      state.lastActionIndex = index
      state.lastEventId = event.id
      state.breakBelowDefenseStreak = 0
      state.bottomObservedAt = null
      state.topObservedAt = null
      state.extremeTopObservedAt = null
      state.topNeutralStreak = 0
    }

    if (event) state.events.push(event)
    state.history.push(historyState(state, bar, score, event))
  }

  const latestClosedDate = closedBars.at(-1)?.date ?? null
  const selected = selectStateAt(state.history, state.events, selectedDate, period)
  const latestFeatures = featureAt(closedBars, closedBars.length - 1, roc20Percentiles)
  const inputHasUnclosed = rows.at(-1)?.isClosed !== true
  const featuresUnavailable = !positive(latestFeatures.atr) || !positive(latestFeatures.ma20) || latestFeatures.position20 == null
  const status: ActionSignalStatus = stale ? 'stale' : inputHasUnclosed || featuresUnavailable ? 'provisional' : 'ready'
  const reason = stale
    ? '当前为过期快照，不确认新的行动信号。'
    : inputHasUnclosed
      ? '当前 K 线尚未收盘，新的行动信号待收盘确认。'
      : featuresUnavailable
        ? '最新闭合 K 线基础指标不足，保留结构回放结果但暂不确认最新状态。'
        : '行动信号基于闭合 K 线、位置、动能衰竭和价格结构；技术评分仅作辅助。'
  return {
    version: ACTION_SIGNAL_VERSION,
    symbol: symbol ?? null,
    assetType: assetType ?? null,
    period,
    status,
    dataStatus: status,
    window: {
      start: rows.at(0)?.date ?? null,
      end: rows.at(-1)?.date ?? null,
      bars: rows.length,
      closedBars: closedBars.length,
    },
    reason,
    analysisStartDate,
    latestClosedDate,
    current: selected.state,
    currentEvent: selected.event,
    events: state.events,
    history: state.history,
    pendingConfirmation: inputHasUnclosed,
    nextConditions: nextConditions(selected.state.phase),
    riskConditions: riskConditions(selected.state.phase, selected.state.defensePrice),
  }
}

export interface ActionSignalMarker {
  date: string
  kind: 'buy' | 'sell'
  label: string
  color: string
  above?: boolean
}

export function actionSignalMarkers(result: ActionSignalResult): ActionSignalMarker[] {
  const colors: Record<ActionSignalType, string> = {
    attack: '#22C55E',
    add: '#3B82F6',
    reduce: '#F59E0B',
    retreat: '#EF4444',
  }
  const labels: Record<ActionSignalType, string> = {
    attack: '试仓',
    add: '加仓',
    reduce: '减仓',
    retreat: '退出',
  }
  return result.events.map(event => ({
    date: event.date,
    kind: event.type === 'attack' || event.type === 'add' ? 'buy' : 'sell',
    label: labels[event.type],
    color: colors[event.type],
    above: event.type === 'reduce' || event.type === 'retreat',
  }))
}

function actionPolarity(action: ActionCurrentAction): 'bullish' | 'defensive' | 'wait' {
  if (action === 'attack' || action === 'add' || action === 'hold') return 'bullish'
  if (action === 'reduce' || action === 'retreat' || action === 'defensive' || action === 'top_observe' || action === 'extreme_top_observe' || action === 'wait_defensive') return 'defensive'
  return 'wait'
}

/** 比较日线与30分钟的行动方向，只提示分歧，不把一个周期冒充另一个周期的确认。 */
export function compareActionSignals(
  current: ActionSignalResult,
  other: ActionSignalResult | null,
): ActionSignalComparison {
  if (!other || other.status === 'blocked') {
    return { status: 'unavailable', period: other?.period ?? (current.period === '1d' ? '30m' : '1d'), text: '另一周期数据不足，暂不可比较。' }
  }
  const currentPolarity = actionPolarity(current.current.action)
  const otherPolarity = actionPolarity(other.current.action)
  if (currentPolarity === otherPolarity) {
    return { status: 'aligned', period: other.period, text: `${other.period === '1d' ? '日线' : '30分钟'}与当前周期方向一致：${currentPolarity === 'bullish' ? '偏多' : currentPolarity === 'defensive' ? '偏防守' : '等待'}。` }
  }
  return { status: 'divergent', period: other.period, text: `${other.period === '1d' ? '日线' : '30分钟'}与当前周期存在方向分歧，请分别等待各自周期确认。` }
}
