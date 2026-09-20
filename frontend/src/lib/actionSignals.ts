import type { ChanlunBarInput } from './chanlun.ts'
import type { ChartDataStatus, KlinePeriod, TechnicalScoreRow, TechnicalScores } from './api.ts'

export const ACTION_SIGNAL_VERSION = 'action-signal-v8' as const
export const ACTION_SIGNAL_WARMUP_BARS = 60

const OBSERVATION_MAX_AGE = 25
const STRUCTURE_LOOKBACK = 40
const PIVOT_SPAN = 2
const ACTION_COOLDOWN_BARS = 5
const ADD_MIN_COOLDOWN_BARS = 3
const ADD_LOW_TOLERANCE_ATR = 0.2
const ADD_BREAKOUT_STRONG_ATR = 0.1
const ADD_BREAKOUT_NORMAL_ATR = 0.2
const ADD_PULLBACK_TOLERANCE_ATR = 0.2
const ADD_PULLBACK_MAX_AGE = 5
const ADD_MAX_TRIGGER_DISTANCE_ATR = 0.8
const ADD_VOLUME_RATIO = 1.1
const ROC_HISTORY_LOOKBACK = 250
const ROC_HISTORY_MIN_SAMPLES = 30
const ROC_HISTORY_FLAT_BAND = 0.0005
const BOTTOM_MA20_ATR_THRESHOLD = -1.2
const BOTTOM_ROC20_PERCENTILE_THRESHOLD = 15
const TRIAL_PIVOT_MAX_AGE = 8
const TRIAL_REVERSAL_WINDOW = 3
const TRIAL_EQUAL_LOW_ATR_TOLERANCE = 0.2
const TRIAL_NEW_LOW_ATR_MARGIN = 0.1
const TRIAL_RSI_IMPROVEMENT = 3
const TRIAL_ROC_IMPROVEMENT = 0.015
const TRIAL_ROC_PERCENTILE_IMPROVEMENT = 10
const TRIAL_MACD_RISING_MOVES = 2
const TRIAL_IMPULSE_CONTRACTION = 0.85
const TRIAL_VOLUME_CONTRACTION = 0.9
const TRIAL_EXHAUSTION_SCORE = 2
const TRIAL_DEFENSE_ATR_BUFFER = 0.2
const TRIAL_MAX_RISK_ATR = 1.5
const TRIAL_MAX_BOTTOM_DISTANCE_ATR = 1.8
const TRIAL_MAX_TRIGGER_DISTANCE_ATR = 0.6
const TRIAL_NUMERIC_EPSILON = 1e-9
const REDUCE_HIGH_WATCH_MAX_AGE = 8
const REDUCE_STILL_HIGH_POSITION_THRESHOLD = 0.7
const REDUCE_STILL_HIGH_DISTANCE_ATR = 0.5
const REDUCE_RECENT_HIGH_DISTANCE_ATR = 1
const REDUCE_TOP_BREAK_ATR = 0.1
const REDUCE_LOCAL_LOW_BREAK_ATR = 0.1
const REDUCE_FALSE_BREAKOUT_LOOKBACK = 4
const DEFENSE_ATR_BUFFER = 0.25
const DEFENSE_STRONG_BREAK_ATR = 0.3
const DEFENSE_RECOVERY_ATR = 0.1
const DEFENSE_RECOVERY_MAX_DISTANCE_ATR = 0.8

export type ActionSignalType = 'attack' | 'add' | 'reduce' | 'retreat'
export type ActionPhase = 'wait' | 'bullish' | 'defensive'
export type ActionObservation = 'bottom_observe' | 'top_observe' | 'extreme_top_observe'
export type ActionDefenseStatus = 'normal' | 'test' | 'break_pending'
export type ActionCurrentAction = ActionSignalType | ActionObservation | 'hold' | 'defensive' | 'defense_test' | 'wait' | 'wait_defensive'
export type ActionSignalStatus = 'ready' | 'provisional' | 'blocked' | 'stale'
export type ActionSignalTrigger = 'breakout' | 'pullback' | 'structure' | 'support_break' | 'score_decay' | 'core_invalidation' | 'exhaustion' | 'neckline_break' | 'recovery' | 'top_structure' | 'false_breakout' | 'break_higher_low' | 'upper_shadow' | 'deceleration' | 'peak_drawdown'

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
  observation: ActionObservation | null
  defenseStatus: ActionDefenseStatus
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
  formationAtr: number | null
}

interface BottomPressureTest {
  previousIndex: number
  latestIndex: number
  previousLow: number
  latestLow: number
  mode: 'new_low' | 'equal_low'
  key: string
}

interface BottomExhaustion {
  confirmed: boolean
  score: number
  coreMomentumImproved: boolean
  pressure: BottomPressureTest | null
  reasons: string[]
}

interface BullishReversalEvidence {
  index: number
  triggerPrice: number
  label: string
}

interface TrialDefenseCandidate {
  pivotIndex: number
  low: number
  price: number
}

interface AddTrigger {
  trigger: 'breakout' | 'neckline_break'
  triggerPrice: number
  structureId: string | null
  structure: HigherLowStructure | null
  label: string
}

interface AddConfirmation {
  momentum: boolean
  volumePrice: boolean
  trendStructure: boolean
  count: number
  reasons: string[]
}

interface PendingAddBreakout {
  index: number
  trigger: 'breakout' | 'neckline_break'
  triggerPrice: number
  structureId: string | null
  defensePrice: number | null
  label: string
}

interface TopStructureBreak {
  triggerPrice: number
  key: string
}

interface FalseBreakout {
  index: number
  priorHigh: number
}

interface ReduceDimension {
  confirmed: boolean
  reasons: string[]
}

interface ReduceExhaustion {
  score: number
  coreWeakening: boolean
  reasons: string[]
}

interface ReducePriceReversal {
  trigger: 'top_structure' | 'false_breakout' | 'break_higher_low' | 'upper_shadow'
  referencePrice: number | null
  structureId: string | null
  label: string
}

interface DefenseReference {
  reduceIndex: number
  reducePrice: number
  reduceHigh: number
  structureLow: number
  atr: number | null
  initialDefensePrice: number | null
}

interface ReplayState {
  phase: ActionPhase
  defensePrice: number | null
  defenseAtr: number | null
  defenseStructureLow: number | null
  defenseReference: DefenseReference | null
  defenseStatus: ActionDefenseStatus
  events: ActionSignalEvent[]
  history: ActionSignalState[]
  usedStructureKeys: Set<string>
  positionStage: 'trial' | 'established' | null
  reducedThisSwing: boolean
  reduceIndex: number | null
  reduceSwingHigh: number | null
  reduceSwingLow: number | null
  lastActionIndex: number
  lastEventId: string | null
  bottomObservedAt: number | null
  topObservedAt: number | null
  extremeTopObservedAt: number | null
  topNeutralStreak: number
  breakBelowDefenseStreak: number
  pendingAddBreakout: PendingAddBreakout | null
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

function hasLongLowerShadow(bar: ActionBar): boolean {
  const range = bar.high - bar.low
  if (!positive(range)) return false
  const body = Math.abs(bar.close - bar.open)
  const lowerShadow = Math.min(bar.open, bar.close) - bar.low
  return lowerShadow >= Math.max(body * 1.5, range * 0.4)
}

function hasLongUpperShadow(bar: ActionBar): boolean {
  const range = bar.high - bar.low
  if (!positive(range)) return false
  const body = Math.abs(bar.close - bar.open)
  const upperShadow = bar.high - Math.max(bar.open, bar.close)
  return upperShadow >= Math.max(body * 1.5, range * 0.4)
}

function bullishReversalEvidenceAt(bars: ActionBar[], index: number): BullishReversalEvidence | null {
  const bar = bars[index]
  const previous = bars[index - 1]
  if (!bar || !previous) return null
  const range = bar.high - bar.low
  const closeInTop35 = bar.close > bar.open && positive(range) && bar.close >= bar.low + range * 0.65
  const previousHighBreak = bar.close > previous.high
  const recentHighs = bars.slice(Math.max(0, index - 2), index).map(item => item.high)
  const recentTwoBarHighBreak = recentHighs.length >= 2 && bar.close > Math.max(...recentHighs)
  const bullishEngulfing = bar.close > bar.open
    && previous.close < previous.open
    && bar.open <= previous.close
    && bar.close >= previous.open
  const lowerShadowConfirmed = hasLongLowerShadow(previous)
    && bar.close >= bar.open
    && bar.close > previous.close

  const evidence = closeInTop35
    ? '阳线收盘位于振幅上方35%'
    : previousHighBreak
      ? '收盘突破前一根高点'
      : recentTwoBarHighBreak
        ? '收盘突破近两根高点'
        : bullishEngulfing
          ? '看涨吞没'
          : lowerShadowConfirmed
            ? '长下影后续确认'
            : null
  return evidence == null ? null : { index, triggerPrice: bar.close, label: evidence }
}

function bullishReversalWithin(bars: ActionBar[], pivotIndex: number, index: number): BullishReversalEvidence | null {
  const end = Math.min(index, pivotIndex + TRIAL_REVERSAL_WINDOW)
  let latest: BullishReversalEvidence | null = null
  for (let cursor = pivotIndex + 1; cursor <= end; cursor += 1) {
    const evidence = bullishReversalEvidenceAt(bars, cursor)
    if (evidence != null) latest = evidence
  }
  return latest
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

function higherHighAt(bars: ActionBar[], index: number): boolean {
  const prior = bars.slice(Math.max(0, index - 5), index).map(bar => bar.high)
  return prior.length >= 3 && bars[index].high >= Math.max(...prior)
}

function previousLowReference(bars: ActionBar[], latestIndex: number): number | null {
  const from = Math.max(0, latestIndex - 8)
  const to = latestIndex - PIVOT_SPAN
  if (to - from + 1 < 3) return null
  let lowestIndex = from
  for (let cursor = from + 1; cursor <= to; cursor += 1) {
    if (bars[cursor].low <= bars[lowestIndex].low) lowestIndex = cursor
  }
  return lowestIndex
}

function bottomPressureTest(bars: ActionBar[], index: number, current: ActionFeatures): BottomPressureTest | null {
  const pivots = confirmedPivotIndices(bars, index, 'bottom')
  for (let pivotOffset = pivots.length - 1; pivotOffset >= 0; pivotOffset -= 1) {
    const latestIndex = pivots[pivotOffset]
    if (index - latestIndex < PIVOT_SPAN || index - latestIndex > TRIAL_PIVOT_MAX_AGE) continue
    const previousIndex = pivots[pivotOffset - 1] ?? previousLowReference(bars, latestIndex)
    if (previousIndex == null || previousIndex >= latestIndex) continue
    const latestLow = bars[latestIndex].low
    const previousLow = bars[previousIndex].low
    const latestFeatures = featureAt(bars, latestIndex)
    const atr = positive(current.atr) ? current.atr : latestFeatures.atr
    if (!positive(atr)) continue
    const difference = latestLow - previousLow
    const mode = difference <= -atr * TRIAL_NEW_LOW_ATR_MARGIN + TRIAL_NUMERIC_EPSILON
      ? 'new_low'
      : Math.abs(difference) <= atr * TRIAL_EQUAL_LOW_ATR_TOLERANCE + TRIAL_NUMERIC_EPSILON
        ? 'equal_low'
        : null
    if (mode != null) {
      return {
        previousIndex,
        latestIndex,
        previousLow,
        latestLow,
        mode,
        key: `${previousIndex}:${latestIndex}`,
      }
    }
  }
  return null
}

function downImpulseAt(bars: ActionBar[], index: number, atr: number | null): number | null {
  if (!positive(atr)) return null
  const losses: number[] = []
  for (let cursor = Math.max(1, index - 2); cursor <= index; cursor += 1) {
    const previousClose = bars[cursor - 1]?.close
    const close = bars[cursor]?.close
    if (!positive(previousClose) || !positive(close)) continue
    const change = close - previousClose
    if (change < 0) losses.push(Math.abs(change))
  }
  return losses.length ? average(losses)! / atr : null
}

function rsiRisingLastThree(bars: ActionBar[], index: number, roc20Percentiles?: Map<string, number>): boolean {
  if (index < 2) return false
  const values = [index - 2, index - 1, index]
    .map(cursor => featureAt(bars, cursor, roc20Percentiles).rsi)
  return values.every(finite) && values[0]! < values[1]! && values[1]! < values[2]!
}

function macdRisingMoves(bars: ActionBar[], index: number, roc20Percentiles?: Map<string, number>): number {
  let moves = 0
  for (let cursor = Math.max(1, index - 2); cursor <= index; cursor += 1) {
    const previous = featureAt(bars, cursor - 1, roc20Percentiles).macdHist
    const current = featureAt(bars, cursor, roc20Percentiles).macdHist
    if (finite(previous) && finite(current) && current > previous) moves += 1
  }
  return moves
}

function evaluateBottomExhaustion(
  bars: ActionBar[],
  index: number,
  current: ActionFeatures,
  roc20Percentiles?: Map<string, number>,
): BottomExhaustion {
  const pressure = index < 3 ? null : bottomPressureTest(bars, index, current)
  if (!pressure) {
    return { confirmed: false, score: 0, coreMomentumImproved: false, pressure: null, reasons: [] }
  }

  const previous = featureAt(bars, pressure.previousIndex, roc20Percentiles)
  const latest = featureAt(bars, pressure.latestIndex, roc20Percentiles)
  const rsiImproved = (previous.rsi != null
    && ((latest.rsi != null && latest.rsi >= previous.rsi + TRIAL_RSI_IMPROVEMENT)
      || (current.rsi != null && current.rsi >= previous.rsi + TRIAL_RSI_IMPROVEMENT)))
    || rsiRisingLastThree(bars, index, roc20Percentiles)
  const rocImproved = previous.roc20 != null
    && ((latest.roc20 != null && latest.roc20 >= previous.roc20 + TRIAL_ROC_IMPROVEMENT)
      || (current.roc20 != null && current.roc20 >= previous.roc20 + TRIAL_ROC_IMPROVEMENT)
      || (latest.roc20Percentile != null
        && previous.roc20Percentile != null
        && latest.roc20Percentile >= previous.roc20Percentile + TRIAL_ROC_PERCENTILE_IMPROVEMENT)
      || (current.roc20Percentile != null
        && previous.roc20Percentile != null
        && current.roc20Percentile >= previous.roc20Percentile + TRIAL_ROC_PERCENTILE_IMPROVEMENT))
  const macdImproved = previous.macdHist != null
    && ((latest.macdHist != null && latest.macdHist > previous.macdHist)
      || (current.macdHist != null && current.macdHist > previous.macdHist))
    && macdRisingMoves(bars, index, roc20Percentiles) >= TRIAL_MACD_RISING_MOVES
  const previousImpulse = downImpulseAt(bars, pressure.previousIndex, previous.atr)
  const latestImpulse = downImpulseAt(bars, pressure.latestIndex, latest.atr)
  const impulseContracted = previousImpulse != null
    && latestImpulse != null
    && previousImpulse > 0
    && latestImpulse <= previousImpulse * TRIAL_IMPULSE_CONTRACTION
  const volumeContracted = positive(previous.volumeRatio)
    && positive(latest.volumeRatio)
    && latest.volumeRatio <= previous.volumeRatio * TRIAL_VOLUME_CONTRACTION
  const coreMomentumImproved = countTrue([rsiImproved, rocImproved, macdImproved]) >= 1
  const score = (rsiImproved ? 1 : 0)
    + (rocImproved ? 1 : 0)
    + (macdImproved ? 1 : 0)
    + (impulseContracted ? 0.5 : 0)
    + (volumeContracted ? 0.5 : 0)
  const reasons = [
    `底部压力测试：${pressure.mode === 'new_low' ? '新低' : '近似等低'}`,
    `试仓衰竭评分 ${score.toFixed(1)}（门槛 ${TRIAL_EXHAUSTION_SCORE.toFixed(1)}）`,
    rsiImproved ? 'RSI改善' : null,
    rocImproved ? 'ROC改善' : null,
    macdImproved ? 'MACD柱改善' : null,
    impulseContracted ? '下跌冲击收缩' : null,
    volumeContracted ? '探底量能收缩' : null,
  ].filter((item): item is string => item != null)
  return {
    confirmed: score >= TRIAL_EXHAUSTION_SCORE && coreMomentumImproved,
    score,
    coreMomentumImproved,
    pressure,
    reasons,
  }
}

function recentHighBreakAt(bars: ActionBar[], index: number, lookback: number): number | null {
  const priorHighs = bars.slice(Math.max(0, index - lookback), index).map(bar => bar.high)
  if (priorHighs.length < lookback) return null
  const triggerPrice = Math.max(...priorHighs)
  return bars[index].close > triggerPrice ? triggerPrice : null
}

function recentHighReference(bars: ActionBar[], index: number, lookback: number, minSamples = lookback): number | null {
  const highs = bars.slice(Math.max(0, index - lookback), index).map(bar => bar.high).filter(finite)
  return highs.length >= minSamples ? Math.max(...highs) : null
}

function reduceStillHigh(bars: ActionBar[], index: number, features: ActionFeatures, close: number): ReduceDimension {
  const distance = finite(features.ma20) && positive(features.atr) ? (close - features.ma20!) / features.atr! : null
  const positionHigh = features.position20 != null && features.position20 >= REDUCE_STILL_HIGH_POSITION_THRESHOLD
  const ma20High = distance != null && distance >= REDUCE_STILL_HIGH_DISTANCE_ATR
  const windowHighs = bars.slice(Math.max(0, index - 19), index + 1).map(bar => bar.high).filter(finite)
  const recentHigh = windowHighs.length ? Math.max(...windowHighs) : null
  const nearRecentHigh = recentHigh != null
    && positive(features.atr)
    && recentHigh - close <= features.atr * REDUCE_RECENT_HIGH_DISTANCE_ATR
  const reasons = [
    positionHigh ? `20根位置 ${(features.position20! * 100).toFixed(0)}%` : null,
    ma20High ? `价格偏离 MA20 ${distance!.toFixed(1)} ATR` : null,
    nearRecentHigh ? `距离近20根最高价 ${(recentHigh! - close).toFixed(1)} ATR` : null,
  ].filter((item): item is string => item != null)
  return { confirmed: positionHigh || ma20High || nearRecentHigh, reasons }
}

function upwardPushContraction(bars: ActionBar[], index: number, atr: number | null): boolean {
  if (index < 6 || !positive(atr)) return false
  const previousRise = bars[index - 3].close - bars[index - 6].close
  const recentRise = bars[index].close - bars[index - 3].close
  return previousRise >= atr * 0.2
    && recentRise <= previousRise * 0.7
    && recentRise >= -atr * 0.5
}

function reduceExhaustion(
  bars: ActionBar[],
  index: number,
  roc20Percentiles?: Map<string, number>,
): ReduceExhaustion {
  const current = featureAt(bars, index, roc20Percentiles)
  const previous = featureAt(bars, index - 1, roc20Percentiles)
  const rsiWeak = current.rsi != null && previous.rsi != null && current.rsi <= previous.rsi - 1
  const rocWeak = (current.roc5 != null && previous.roc5 != null && current.roc5 < previous.roc5)
    || (current.roc20 != null && previous.roc20 != null && current.roc20 < previous.roc20)
  const macdWeak = current.macdHist != null && previous.macdHist != null && current.macdHist < previous.macdHist
  const pushContracted = upwardPushContraction(bars, index, current.atr)
  const volumeWeak = reduceVolumePriceWeakness(bars, index, current).confirmed
  const coreWeakening = rsiWeak || rocWeak || macdWeak
  const score = (rsiWeak ? 1 : 0)
    + (rocWeak ? 1 : 0)
    + (macdWeak ? 1 : 0)
    + (pushContracted ? 0.5 : 0)
    + (volumeWeak ? 0.5 : 0)
  const reasons = [
    rsiWeak ? 'RSI走弱 +1' : null,
    rocWeak ? 'ROC走弱 +1' : null,
    macdWeak ? 'MACD柱走弱 +1' : null,
    pushContracted ? '上涨推动收缩 +0.5' : null,
    volumeWeak ? '量价背离 +0.5' : null,
  ].filter((item): item is string => item != null)
  return { score, coreWeakening, reasons }
}

function topStructureBreakAt(bars: ActionBar[], index: number, features: ActionFeatures): TopStructureBreak | null {
  if (!positive(features.atr)) return null
  const pivots = confirmedPivotIndices(bars, index, 'top')
  for (const pivotIndex of pivots.slice(-3).reverse()) {
    if (index - pivotIndex < PIVOT_SPAN || index - pivotIndex > 12) continue
    const triggerPrice = bars[pivotIndex].low
    if (bars[index].close >= triggerPrice - features.atr * REDUCE_TOP_BREAK_ATR - TRIAL_NUMERIC_EPSILON) continue
    return {
      triggerPrice,
      key: `top:${pivotIndex}`,
    }
  }
  return null
}

function falseBreakoutAt(bars: ActionBar[], index: number, features: ActionFeatures): FalseBreakout | null {
  if (!positive(features.atr)) return null
  const from = Math.max(20, index - REDUCE_FALSE_BREAKOUT_LOOKBACK)
  for (let candidateIndex = from; candidateIndex <= index; candidateIndex += 1) {
    const priorHigh = recentHighReference(bars, candidateIndex, 20, 10)
    if (priorHigh == null || bars[candidateIndex].high <= priorHigh + TRIAL_NUMERIC_EPSILON) continue
    const confirmationClose = bars[index].close
    if (confirmationClose < priorHigh - features.atr * REDUCE_TOP_BREAK_ATR - TRIAL_NUMERIC_EPSILON) {
      return { index: candidateIndex, priorHigh }
    }
  }
  return null
}

function reduceVolumePriceWeakness(bars: ActionBar[], index: number, features: ActionFeatures): ReduceDimension {
  const bar = bars[index]
  const previous = bars[index - 1]
  const previousFeatures = previous ? featureAt(bars, index - 1) : null
  const priorHigh = recentHighReference(bars, index, 20, 10)
  const highWithoutVolume = priorHigh != null
    && positive(features.atr)
    && bar.high >= priorHigh - features.atr * REDUCE_TOP_BREAK_ATR
    && features.volumeRatio != null
    && features.volumeRatio < 1
  const upOnLowerVolume = previous != null
    && bar.close > previous.close
    && features.volumeRatio != null
    && features.volumeRatio < 1
  const highVolumeStagnation = features.volumeRatio != null
    && features.volumeRatio >= 1.5
    && previous != null
    && positive(features.atr)
    && Math.abs(bar.close - previous.close) <= features.atr * 0.3
  const volumeFadingOnPullback = isBearishReversal(bars, index)
    && features.volumeRatio != null
    && previousFeatures?.volumeRatio != null
    && features.volumeRatio < previousFeatures.volumeRatio
  const reasons = [
    highWithoutVolume ? '接近前高但量比低于1' : null,
    upOnLowerVolume ? '上涨缩量' : null,
    highVolumeStagnation ? '高位放量滞涨' : null,
    volumeFadingOnPullback ? '回落时量能继续衰减' : null,
  ].filter((item): item is string => item != null)
  return { confirmed: reasons.length > 0, reasons }
}

function breakHigherLowAt(bars: ActionBar[], index: number, features: ActionFeatures): ReducePriceReversal | null {
  if (!positive(features.atr)) return null
  const structure = higherLowStructure(bars, index, features)
  if (structure == null || index - structure.latestIndex < PIVOT_SPAN || index - structure.latestIndex > 12) return null
  const priorHigh = recentHighReference(bars, structure.latestIndex, 8, 3)
  const higherHighConfirmed = structure.neckline != null
    && priorHigh != null
    && structure.neckline > priorHigh + features.atr * REDUCE_TOP_BREAK_ATR
  if (!higherHighConfirmed || bars[index].close >= structure.latestLow - features.atr * REDUCE_LOCAL_LOW_BREAK_ATR) return null
  return {
    trigger: 'break_higher_low',
    referencePrice: structure.latestLow,
    structureId: structure.key,
    label: `Higher Low 后跌破防守低点 ${structure.latestLow.toFixed(3)}`,
  }
}

function upperShadowReversalAt(bars: ActionBar[], index: number): ReducePriceReversal | null {
  const previous = bars[index - 1]
  if (previous == null || !hasLongUpperShadow(previous) || !isBearishReversal(bars, index)) return null
  return {
    trigger: 'upper_shadow',
    referencePrice: previous.high,
    structureId: null,
    label: `长上影后次根 K 线继续回落 ${previous.high.toFixed(3)}`,
  }
}

function reducePriceReversalAt(bars: ActionBar[], index: number, features: ActionFeatures): ReducePriceReversal | null {
  const topBreak = topStructureBreakAt(bars, index, features)
  if (topBreak != null) {
    return {
      trigger: 'top_structure',
      referencePrice: topBreak.triggerPrice,
      structureId: topBreak.key,
      label: `确认顶分型后跌破中间 K 线低点 ${topBreak.triggerPrice.toFixed(3)}`,
    }
  }
  const failedBreakout = falseBreakoutAt(bars, index, features)
  if (failedBreakout != null) {
    return {
      trigger: 'false_breakout',
      referencePrice: failedBreakout.priorHigh,
      structureId: null,
      label: `冲高失败，收盘跌回前高 ${failedBreakout.priorHigh.toFixed(3)} 下方`,
    }
  }
  const higherLowBreak = breakHigherLowAt(bars, index, features)
  if (higherLowBreak != null) return higherLowBreak
  return upperShadowReversalAt(bars, index)
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

function higherLowStructure(
  bars: ActionBar[],
  index: number,
  features: ActionFeatures,
  lowToleranceAtr = 0,
): HigherLowStructure | null {
  const pivots = confirmedPivotIndices(bars, index, 'bottom')
  if (pivots.length < 2) return null
  const latestIndex = pivots.at(-1)!
  const previousIndex = pivots.at(-2)!
  const latestLow = bars[latestIndex].low
  const previousLow = bars[previousIndex].low
  const tolerance = Math.max((features.atr ?? latestLow * 0.005) * 0.1, latestLow * 0.001)
  if (lowToleranceAtr > 0) {
    const atrTolerance = positive(features.atr) ? features.atr * lowToleranceAtr : latestLow * 0.002
    if (latestLow < previousLow - atrTolerance - TRIAL_NUMERIC_EPSILON) return null
  } else if (latestLow <= previousLow + tolerance) {
    return null
  }
  const necklineValues = bars.slice(latestIndex + 1, index).map(bar => bar.high).filter(positive)
  const neckline = necklineValues.length ? Math.max(...necklineValues) : null
  const formationFeatures = featureAt(bars, latestIndex)
  return {
    previousIndex,
    latestIndex,
    previousLow,
    latestLow,
    key: `${previousIndex}:${latestIndex}`,
    neckline,
    formationAtr: positive(formationFeatures.atr) ? formationFeatures.atr : features.atr,
  }
}

function currentSwingHigh(bars: ActionBar[], index: number): number | null {
  const highs = bars.slice(Math.max(0, index - 19), index + 1).map(bar => bar.high).filter(finite)
  return highs.length ? Math.max(...highs) : null
}

function latestConfirmedSwingLow(bars: ActionBar[], index: number): number | null {
  const pivotIndex = confirmedPivotIndices(bars, index, 'bottom').at(-1)
  return pivotIndex == null ? null : bars[pivotIndex].low
}

function latestConfirmedSwingHigh(bars: ActionBar[], index: number): number | null {
  const pivotIndex = confirmedPivotIndices(bars, index, 'top').at(-1)
  return pivotIndex == null ? null : bars[pivotIndex].high
}

function rearmReduceSwing(
  state: ReplayState,
  index: number,
  bar: ActionBar,
  features: ActionFeatures,
  structure: HigherLowStructure | null,
): void {
  if (!state.reducedThisSwing || state.reduceIndex == null || index <= state.reduceIndex) return
  state.reduceSwingLow = Math.min(state.reduceSwingLow ?? bar.low, bar.low)
  const previousHighBroken = state.reduceSwingHigh != null
    && bar.close > state.reduceSwingHigh + TRIAL_NUMERIC_EPSILON
  const higherLowHigherHigh = structure != null
    && structure.latestIndex > state.reduceIndex
    && structure.neckline != null
    && positive(features.atr)
    && bar.close > structure.neckline + features.atr * REDUCE_TOP_BREAK_ATR
  const reboundFromReduceLow = state.reduceSwingLow != null
    && positive(features.atr)
    && bar.close - state.reduceSwingLow >= features.atr
  if (previousHighBroken || higherLowHigherHigh || reboundFromReduceLow) {
    state.reducedThisSwing = false
    state.reduceIndex = null
    state.reduceSwingHigh = null
    state.reduceSwingLow = null
  }
}

function addTriggerAt(
  bars: ActionBar[],
  index: number,
  features: ActionFeatures,
  structure: HigherLowStructure | null,
): AddTrigger | null {
  if (!positive(features.atr)) return null
  if (structure?.neckline != null && bars[index].close > structure.neckline + features.atr * ADD_BREAKOUT_STRONG_ATR) {
    return {
      trigger: 'neckline_break',
      triggerPrice: structure.neckline,
      structureId: structure.key,
      structure,
      label: `低点容错后突破颈线 ${structure.neckline.toFixed(3)}`,
    }
  }
  const lookbacks = [5, 10]
  for (const lookback of lookbacks) {
    const triggerPrice = recentHighBreakAt(bars, index, lookback)
    if (triggerPrice != null) {
      return {
        trigger: 'breakout',
        triggerPrice,
        structureId: null,
        structure: null,
        label: `V型反转突破近${lookback}根高点 ${triggerPrice.toFixed(3)}`,
      }
    }
  }
  return null
}

function addConfirmation(
  bars: ActionBar[],
  index: number,
  features: ActionFeatures,
  triggerPrice: number,
  roc20Percentiles?: Map<string, number>,
): AddConfirmation {
  const previous = bars[index - 1]
  const previousFeatures = previous ? featureAt(bars, index - 1, roc20Percentiles) : null
  const momentum = countTrue([
    macdRisingMoves(bars, index, roc20Percentiles) >= TRIAL_MACD_RISING_MOVES,
    features.roc5 != null && features.roc5 > 0,
    features.rsi != null && features.rsi > 50 && previousFeatures?.rsi != null && features.rsi > previousFeatures.rsi,
  ]) >= 1
  const volumePrice = (features.volumeRatio != null && features.volumeRatio >= ADD_VOLUME_RATIO)
    || (previous != null && bars[index].close > previous.close && positive(bars[index].volume) && positive(previous.volume) && bars[index].volume > previous.volume)
  const trendStructure = bars[index].close > triggerPrice
    || (features.ma20 != null && bars[index].close > features.ma20)
  const reasons = [
    momentum ? '动能转强' : null,
    volumePrice ? '量价确认' : null,
    trendStructure ? '结构突破确认' : null,
  ].filter((item): item is string => item != null)
  return { momentum, volumePrice, trendStructure, count: reasons.length, reasons }
}

function triggerDistanceAtr(close: number, triggerPrice: number, atr: number | null): number | null {
  return positive(atr) && positive(triggerPrice) ? (close - triggerPrice) / atr : null
}

function addCooldownReady(index: number, lastActionIndex: number, strong: boolean): boolean {
  return index - lastActionIndex >= (strong ? ADD_MIN_COOLDOWN_BARS : ACTION_COOLDOWN_BARS)
}

function addDefenseIntact(state: ReplayState, close: number): boolean {
  return !positive(state.defensePrice) || (state.breakBelowDefenseStreak === 0 && close > state.defensePrice)
}

function pullbackConfirmed(
  pending: PendingAddBreakout | null,
  index: number,
  bar: ActionBar,
  atr: number | null,
): boolean {
  if (pending == null || !positive(atr) || index <= pending.index || index - pending.index > ADD_PULLBACK_MAX_AGE) return false
  const tolerance = atr * ADD_PULLBACK_TOLERANCE_ATR
  return bar.low >= pending.triggerPrice - tolerance - TRIAL_NUMERIC_EPSILON
    && bar.low <= pending.triggerPrice + tolerance + TRIAL_NUMERIC_EPSILON
    && bar.close > pending.triggerPrice
}

function breakoutCloseQuality(bar: ActionBar): boolean {
  const range = bar.high - bar.low
  return range <= 0 || bar.close >= bar.low + range * 0.6
}

function trialStructureEvidence(
  bars: ActionBar[],
  index: number,
  pressure: BottomPressureTest | null,
  structure: HigherLowStructure | null,
): { improved: boolean; label: string; triggerPrice: number | null } {
  if (structure != null) return { improved: true, label: '确认低点抬高', triggerPrice: null }
  const recentTwoBarTrigger = recentHighBreakAt(bars, index, 2)
  if (recentTwoBarTrigger != null) return { improved: true, label: '收盘突破近两根高点', triggerPrice: recentTwoBarTrigger }
  const recentThreeBarTrigger = recentHighBreakAt(bars, index, 3)
  if (recentThreeBarTrigger != null) return { improved: true, label: '收盘突破近三根高点', triggerPrice: recentThreeBarTrigger }
  if (pressure != null) return { improved: true, label: '确认底分型', triggerPrice: null }
  return { improved: false, label: '', triggerPrice: null }
}

function defenseFor(structure: HigherLowStructure, features: ActionFeatures): number {
  const buffer = positive(structure.formationAtr)
    ? structure.formationAtr * DEFENSE_ATR_BUFFER
    : positive(features.atr)
      ? features.atr * DEFENSE_ATR_BUFFER
      : structure.latestLow * 0.0025
  return structure.latestLow - buffer
}

function defenseForLow(low: number, atr: number | null): number {
  return low - (positive(atr) ? atr * DEFENSE_ATR_BUFFER : low * 0.0025)
}

function raiseDefense(
  state: ReplayState,
  candidate: number | null,
  atr: number | null,
  structureLow: number | null,
): void {
  if (!positive(candidate)) return
  if (state.defensePrice == null || candidate > state.defensePrice + TRIAL_NUMERIC_EPSILON) {
    state.defensePrice = candidate
    state.defenseAtr = positive(atr) ? atr : state.defenseAtr
    state.defenseStructureLow = positive(structureLow) ? structureLow : state.defenseStructureLow
  }
}

function defenseMomentumRecoveryReasons(
  bars: ActionBar[],
  index: number,
  features: ActionFeatures,
  roc20Percentiles?: Map<string, number>,
): string[] {
  const previous = index > 0 ? featureAt(bars, index - 1, roc20Percentiles) : null
  return [
    macdRisingMoves(bars, index, roc20Percentiles) >= TRIAL_MACD_RISING_MOVES ? 'MACD柱连续增强' : null,
    features.roc5 != null && (features.roc5 > 0 || (previous?.roc5 != null && features.roc5 > previous.roc5)) ? 'ROC5重新抬升' : null,
    features.rsi != null && previous?.rsi != null && features.rsi >= 55 && features.rsi > previous.rsi ? 'RSI重新站上55并抬升' : null,
  ].filter((item): item is string => item != null)
}

function trialDefenseFor(pressure: BottomPressureTest, features: ActionFeatures): TrialDefenseCandidate {
  const buffer = positive(features.atr) ? features.atr * TRIAL_DEFENSE_ATR_BUFFER : pressure.latestLow * 0.002
  return {
    pivotIndex: pressure.latestIndex,
    low: pressure.latestLow,
    price: pressure.latestLow - buffer,
  }
}

function validDefense(value: number | null, close: number): value is number {
  return positive(value) && value < close
}

function trialRiskAtr(defense: number | null, close: number, atr: number | null): number | null {
  return validDefense(defense, close) && positive(atr) ? (close - defense) / atr : null
}

function trialNotChasing(
  pressure: BottomPressureTest,
  close: number,
  atr: number | null,
  triggerPrice: number | null,
): boolean {
  if (!positive(atr)) return false
  if ((close - pressure.latestLow) / atr > TRIAL_MAX_BOTTOM_DISTANCE_ATR + TRIAL_NUMERIC_EPSILON) return false
  if (triggerPrice != null && (close - triggerPrice) / atr > TRIAL_MAX_TRIGGER_DISTANCE_ATR + TRIAL_NUMERIC_EPSILON) return false
  return true
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
  if (state.phase === 'defensive') return state.defenseStatus === 'test' ? 'defense_test' : 'defensive'
  if (state.bottomObservedAt != null) return 'bottom_observe'
  if (state.extremeTopObservedAt != null) return 'extreme_top_observe'
  return state.topObservedAt != null ? 'top_observe' : 'wait'
}

function observationForState(state: ReplayState): ActionObservation | null {
  if (state.bottomObservedAt != null) return 'bottom_observe'
  if (state.extremeTopObservedAt != null) return 'extreme_top_observe'
  return state.topObservedAt != null ? 'top_observe' : null
}

function cloneScore(score: ActionScore): ActionScore {
  return { ...score }
}

function historyState(state: ReplayState, bar: ActionBar, score: ActionScore, event?: ActionSignalEvent): ActionSignalState {
  return {
    date: bar.date,
    phase: state.phase,
    action: event?.type ?? actionForState(state),
    observation: observationForState(state),
    defenseStatus: state.defenseStatus,
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
    current: { date: null, phase: 'wait', action: 'wait', observation: null, defenseStatus: 'normal', score: null, defensePrice: null, eventId: null },
    currentEvent: null,
    events: [],
    history: [],
    pendingConfirmation: false,
    nextConditions: ['超跌只进入底部观察；衰竭评分达标且反转或结构改善后才试仓', '试仓/防守后 HL + 颈线突破或减仓前高 + 动能恢复 → 加仓/回补'],
    riskConditions: ['近8根有高位观察、当前仍在高位、衰竭评分≥2且价格反转 → 减仓（不依赖持仓/加仓状态）', '防守位测试不退出；连续2根收盘跌破或单根深破 → 退出'],
  }
}

function nextConditions(phase: ActionPhase): string[] {
  if (phase === 'wait') return ['底部观察 → 衰竭评分达标 + 反转或结构改善 → 试仓', '试仓后突破颈线/近5或10根高点，满足2/3确认；弱突破等待回踩 → 加仓']
  if (phase === 'defensive') return ['HL + 颈线突破且不追高，或突破减仓前高 + 动能恢复 → 加仓/回补', '防守位测试不退出；连续2根收盘跌破或单根深破 → 退出']
  return ['本轮只减一次；重新突破前高、确认 Higher Low→Higher High 或从减仓低点反弹≥1 ATR 后，才开启下一轮减仓', '跌破抬高低点防守位，二次确认反抽失败 → 退出']
}

function riskConditions(phase: ActionPhase, defensePrice: number | null): string[] {
  if (defensePrice != null) return [`核心防守位 ${defensePrice.toFixed(3)}：下影测试不退出，连续2根收盘跌破或单根深破 → 退出`, '近8根有高位观察、当前仍在高位、衰竭评分≥2且价格反转 → 减仓（不依赖持仓/加仓状态）']
  if (phase === 'wait') return ['尚未建立仓位；超跌阶段只观察，不追涨杀跌', '高位观察 + 当前仍在高位 + 顶部衰竭评分≥2 + 价格反转 → 减仓（不依赖持仓/加仓状态）']
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
  const state = states.at(-1) ?? { date: null, phase: 'wait', action: 'wait', observation: null, defenseStatus: 'normal' as const, score: null, defensePrice: null, eventId: null }
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
    defenseAtr: null,
    defenseStructureLow: null,
    defenseReference: null,
    defenseStatus: 'normal',
    events: [],
    history: [],
    usedStructureKeys: new Set(),
    positionStage: null,
    reducedThisSwing: false,
    reduceIndex: null,
    reduceSwingHigh: null,
    reduceSwingLow: null,
    lastActionIndex: -Infinity,
    lastEventId: null,
    bottomObservedAt: null,
    topObservedAt: null,
    extremeTopObservedAt: null,
    topNeutralStreak: 0,
    breakBelowDefenseStreak: 0,
    pendingAddBreakout: null,
  }
  let analysisStartDate: string | null = null

  for (let index = 0; index < closedBars.length; index += 1) {
    const bar = closedBars[index]
    const score = scoreFor(scoreMap, bar, period)
    const features = featureAt(closedBars, index, roc20Percentiles)
    const lowerExhaustion = evaluateBottomExhaustion(closedBars, index, features, roc20Percentiles)
    const upperExhaustion = topExhaustion(closedBars, index, features, roc20Percentiles)
    const bottomObservation = isBottomObservation(features, bar.close) || lowerExhaustion.confirmed
    const topObservation = isTopObservation(features, bar.close)
    const extremeTopObservation = isExtremeTopObservation(features, bar.close)
    const topWatch = topObservation || extremeTopObservation

    if (bottomObservation) state.bottomObservedAt = index
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

    const structure = higherLowStructure(closedBars, index, features)
    const addStructureCandidate = higherLowStructure(closedBars, index, features, ADD_LOW_TOLERANCE_ATR)
    const addStructure = addStructureCandidate != null && !state.usedStructureKeys.has(addStructureCandidate.key)
      ? addStructureCandidate
      : null
    const defenseStartIndex = state.defenseReference?.reduceIndex ?? state.reduceIndex
    const postReduceStructure = state.phase === 'defensive'
      && structure != null
      && (defenseStartIndex == null || structure.latestIndex > defenseStartIndex)
      ? structure
      : null
    if (postReduceStructure != null) {
      raiseDefense(state, defenseFor(postReduceStructure, features), postReduceStructure.formationAtr, postReduceStructure.latestLow)
    }
    state.defenseStatus = 'normal'
    const defenseTest = state.phase !== 'wait'
      && positive(state.defensePrice)
      && bar.low < state.defensePrice
      && bar.close >= state.defensePrice
    if (defenseTest) {
      state.breakBelowDefenseStreak = 0
      state.defenseStatus = 'test'
    } else if (state.phase !== 'wait' && positive(state.defensePrice) && bar.close < state.defensePrice) {
      state.breakBelowDefenseStreak += 1
      state.defenseStatus = 'break_pending'
    } else {
      state.breakBelowDefenseStreak = 0
    }

    const addTriggerStructure = state.phase === 'defensive' ? postReduceStructure : addStructure
    const addTrigger = addTriggerAt(closedBars, index, features, addTriggerStructure)
    const pressure = lowerExhaustion.pressure
    const trialDefenseCandidate = pressure ? trialDefenseFor(pressure, features) : null
    const reversalEvidence = pressure ? bullishReversalWithin(closedBars, pressure.latestIndex, index) : null
    const trialStructure = trialStructureEvidence(closedBars, index, pressure, structure)
    const trialTriggerPrice = reversalEvidence?.triggerPrice ?? trialStructure.triggerPrice
    const riskAtr = trialRiskAtr(trialDefenseCandidate?.price ?? null, bar.close, features.atr)
    const bottomObservationFresh = state.bottomObservedAt != null && index - state.bottomObservedAt <= OBSERVATION_MAX_AGE
    rearmReduceSwing(state, index, bar, features, structure)
    const hadPosition = state.phase !== 'wait' && state.positionStage != null
    const recentHighWatch = state.topObservedAt != null && index - state.topObservedAt <= REDUCE_HIGH_WATCH_MAX_AGE
    const stillHigh = reduceStillHigh(closedBars, index, features, bar.close)
    const reduceExhaustionResult = reduceExhaustion(closedBars, index, roc20Percentiles)
    const priceReversal = reducePriceReversalAt(closedBars, index, features)
    const reduceReady = state.phase !== 'defensive'
      && !state.reducedThisSwing
      && recentHighWatch
      && stillHigh.confirmed
      && reduceExhaustionResult.score >= 2
      && reduceExhaustionResult.coreWeakening
      && priceReversal != null
    const addConfirmationResult = addTrigger == null
      ? null
      : addConfirmation(closedBars, index, features, addTrigger.triggerPrice, roc20Percentiles)
    const addDistance = addTrigger == null ? null : triggerDistanceAtr(bar.close, addTrigger.triggerPrice, features.atr)
    const addStrong = addConfirmationResult != null && addConfirmationResult.count >= 3
    const defenseAddTriggerAllowed = state.phase !== 'defensive' || addTrigger?.trigger === 'neckline_break'
    const defensePullbackAllowed = state.phase !== 'defensive' || state.pendingAddBreakout?.trigger === 'neckline_break'
    const defenseImmediateRecoveryAllowed = state.phase !== 'defensive'
      || addTrigger?.trigger !== 'neckline_break'
      || breakoutCloseQuality(bar)
    const addDistanceWithinLimit = state.phase !== 'defensive'
      || (addDistance != null && addDistance <= TRIAL_MAX_TRIGGER_DISTANCE_ATR + TRIAL_NUMERIC_EPSILON)
    const minimumBreakoutDistance = state.phase === 'defensive' && addTrigger?.trigger === 'neckline_break'
      ? ADD_BREAKOUT_STRONG_ATR
      : addStrong ? ADD_BREAKOUT_STRONG_ATR : ADD_BREAKOUT_NORMAL_ATR
    const recoveryMomentumReasons = defenseMomentumRecoveryReasons(closedBars, index, features, roc20Percentiles)
    const recoveryAtr = state.defenseReference?.atr ?? state.defenseAtr ?? features.atr
    const recoveryDistance = state.defenseReference?.reduceHigh != null
      ? triggerDistanceAtr(bar.close, state.defenseReference.reduceHigh, recoveryAtr)
      : null
    const defenseVRecovery = state.phase === 'defensive'
      && state.defenseReference?.reduceHigh != null
      && positive(recoveryAtr)
      && bar.close >= state.defenseReference.reduceHigh + recoveryAtr * DEFENSE_RECOVERY_ATR
      && recoveryDistance != null
      && recoveryDistance <= DEFENSE_RECOVERY_MAX_DISTANCE_ATR + TRIAL_NUMERIC_EPSILON
      && recoveryMomentumReasons.length > 0
    const immediateBreakout = addTrigger != null
      && addConfirmationResult != null
      && defenseAddTriggerAllowed
      && defenseImmediateRecoveryAllowed
      && addConfirmationResult.count >= 2
      && (addTrigger.trigger !== 'breakout' || (addConfirmationResult.momentum && addConfirmationResult.volumePrice))
      && addDistance != null
      && addDistance <= ADD_MAX_TRIGGER_DISTANCE_ATR + TRIAL_NUMERIC_EPSILON
      && addDistanceWithinLimit
      && addDistance >= minimumBreakoutDistance - TRIAL_NUMERIC_EPSILON
    const pullbackTrigger = state.pendingAddBreakout != null
      && pullbackConfirmed(state.pendingAddBreakout, index, bar, features.atr)
      ? {
          trigger: 'pullback' as const,
          triggerPrice: state.pendingAddBreakout.triggerPrice,
          structureId: state.pendingAddBreakout.structureId,
          structure: null,
          label: `${state.pendingAddBreakout.label}后回踩收回${state.pendingAddBreakout.trigger === 'neckline_break' ? '颈线' : '突破位'}`,
        }
      : null
    const pullbackConfirmation = pullbackTrigger == null
      ? null
      : addConfirmation(closedBars, index, features, pullbackTrigger.triggerPrice, roc20Percentiles)
    const addBaseReady = state.phase !== 'wait'
      && addDefenseIntact(state, bar.close)
      && !upperExhaustion
      && !topWatch
    const addTriggerReady = addBaseReady
      && ((immediateBreakout && addCooldownReady(index, state.lastActionIndex, addStrong))
        || (pullbackTrigger != null
          && defensePullbackAllowed
          && pullbackConfirmation != null
          && pullbackConfirmation.count >= 2
          && (state.pendingAddBreakout?.trigger !== 'breakout' || pullbackConfirmation.momentum)
          && addCooldownReady(index, state.lastActionIndex, false)))
    const defenseBreakDistance = positive(state.defensePrice) && positive(recoveryAtr)
      ? (state.defensePrice - bar.close) / recoveryAtr
      : null
    // 防守位统一按“连续两根收盘跌破”或“单根收盘深破 0.3 ATR”确认失效。
    // 下影测试会在上面清零连续计数，不应直接触发退出。
    const coreInvalidation = state.phase !== 'wait'
      && positive(state.defensePrice)
      && (state.breakBelowDefenseStreak >= 2
        || (defenseBreakDistance != null && defenseBreakDistance >= DEFENSE_STRONG_BREAK_ATR - TRIAL_NUMERIC_EPSILON))
    const trialEntry = state.phase !== 'bullish'
      && bottomObservationFresh
      && lowerExhaustion.confirmed
      && (reversalEvidence != null || trialStructure.improved)
      && (state.phase !== 'defensive' || addDefenseIntact(state, bar.close))
      && trialDefenseCandidate != null
      && riskAtr != null
      && riskAtr <= TRIAL_MAX_RISK_ATR + TRIAL_NUMERIC_EPSILON
      && pressure != null
      && trialNotChasing(pressure, bar.close, features.atr, trialTriggerPrice)

    let event: ActionSignalEvent | undefined
    if (!stale && coreInvalidation) {
      event = createEvent('retreat', 'core_invalidation', period, bar, score, state.defensePrice, state.defensePrice, null, [
        defenseBreakDistance != null && defenseBreakDistance >= DEFENSE_STRONG_BREAK_ATR
          ? `单根收盘深破核心防守位 ${state.defensePrice!.toFixed(3)} 达 ${defenseBreakDistance.toFixed(1)} ATR`
          : state.breakBelowDefenseStreak >= 2
            ? `连续 ${state.breakBelowDefenseStreak} 根收盘跌破核心防守位 ${state.defensePrice!.toFixed(3)}`
            : `收盘跌破核心防守位 ${state.defensePrice!.toFixed(3)} 达 ${defenseBreakDistance?.toFixed(1) ?? '—'} ATR`,
        hadPosition ? '确认防守失败，退出剩余仓位' : '确认防守失败，结束当前高位风险状态',
        ...auxiliaryScoreReason(score),
      ])
      state.phase = 'wait'
      state.defensePrice = null
      state.defenseAtr = null
      state.defenseStructureLow = null
      state.defenseReference = null
      state.defenseStatus = 'normal'
      state.positionStage = null
      state.reducedThisSwing = false
      state.reduceIndex = null
      state.reduceSwingHigh = null
      state.reduceSwingLow = null
      state.lastActionIndex = index
      state.lastEventId = event.id
      state.bottomObservedAt = null
      state.topObservedAt = null
      state.extremeTopObservedAt = null
      state.topNeutralStreak = 0
      state.breakBelowDefenseStreak = 0
    } else if (!stale && defenseVRecovery && index > (state.defenseReference?.reduceIndex ?? state.reduceIndex ?? -1)) {
      event = createEvent('add', 'recovery', period, bar, score, state.defenseReference!.reduceHigh, state.defensePrice, null, [
        `防守期间突破减仓前高 ${state.defenseReference!.reduceHigh.toFixed(3)} + ${DEFENSE_RECOVERY_ATR.toFixed(1)} ATR`,
        '动能重新增强，允许小幅回补',
        ...recoveryMomentumReasons,
        recoveryDistance != null ? `突破距离 ${recoveryDistance.toFixed(1)} ATR，未追高` : null,
        ...auxiliaryScoreReason(score),
      ].filter((item): item is string => item != null))
      state.phase = 'bullish'
      state.positionStage = 'trial'
      state.lastActionIndex = index
      state.lastEventId = event.id
      state.pendingAddBreakout = null
      state.defenseStatus = 'normal'
      state.breakBelowDefenseStreak = 0
      state.bottomObservedAt = null
      state.topObservedAt = null
      state.extremeTopObservedAt = null
      state.topNeutralStreak = 0
    } else if (!stale && reduceReady && priceReversal != null) {
      const highWatchAge = state.topObservedAt == null ? null : index - state.topObservedAt
      const structureLow = structure?.latestLow ?? latestConfirmedSwingLow(closedBars, index) ?? state.reduceSwingLow ?? bar.low
      const structureAtr = structure?.formationAtr ?? features.atr ?? state.defenseAtr
      const candidateDefense = structure != null ? defenseFor(structure, features) : defenseForLow(structureLow, structureAtr)
      raiseDefense(state, candidateDefense, structureAtr, structureLow)
      const reduceHigh = currentSwingHigh(closedBars, index) ?? latestConfirmedSwingHigh(closedBars, index) ?? bar.high
      state.defenseReference = {
        reduceIndex: index,
        reducePrice: bar.close,
        reduceHigh,
        structureLow,
        atr: positive(features.atr) ? features.atr : structureAtr,
        initialDefensePrice: state.defensePrice,
      }
      event = createEvent('reduce', priceReversal.trigger, period, bar, score, priceReversal.referencePrice, state.defensePrice, priceReversal.structureId, [
        priceReversal.label,
        hadPosition ? '减仓后进入防守，冻结减仓参考高点、结构低点和 ATR' : '高位风险确认，进入防守并冻结参考高点、结构低点和 ATR',
        `减仓参考高点 ${reduceHigh.toFixed(3)}，结构低点 ${structureLow.toFixed(3)}`,
        `防守 ATR ${state.defenseReference.atr?.toFixed(3) ?? '—'}，核心防守位 ${state.defensePrice?.toFixed(3) ?? '—'}`,
        `高位观察距今 ${highWatchAge ?? '—'} 根，当前仍处于相对高位`,
        ...stillHigh.reasons,
        ...reduceExhaustionResult.reasons,
        `顶部衰竭评分 ${reduceExhaustionResult.score.toFixed(1)}（门槛 2.0）`,
        ...locationReasons(features, bar.close),
        ...auxiliaryScoreReason(score),
      ].filter((item): item is string => item != null))
      // 一轮上涨只执行一次减仓；新波段恢复后由 rearmReduceSwing 解锁。
      state.phase = 'defensive'
      state.reducedThisSwing = true
      state.reduceIndex = index
      state.reduceSwingHigh = reduceHigh
      state.reduceSwingLow = bar.low
      state.lastActionIndex = index
      state.lastEventId = event.id
      state.bottomObservedAt = null
      state.topObservedAt = null
      state.extremeTopObservedAt = null
      state.topNeutralStreak = 0
      state.pendingAddBreakout = null
      state.defenseStatus = 'normal'
    } else if (!stale && addTriggerReady && (pullbackTrigger != null || addTrigger != null)) {
      const recoveringFromDefense = state.phase === 'defensive'
      const trigger = pullbackTrigger ?? addTrigger!
      const confirmation = pullbackConfirmation ?? addConfirmationResult!
      const pendingDefense = state.pendingAddBreakout?.defensePrice ?? null
      const nextDefense = trigger.structure ? defenseFor(trigger.structure, features) : pendingDefense
      const distance = triggerDistanceAtr(bar.close, trigger.triggerPrice, features.atr)
      event = createEvent('add', trigger.trigger, period, bar, score, trigger.triggerPrice, state.defensePrice, trigger.structureId, [
        trigger.label,
        recoveringFromDefense
          ? '防守阶段 HL + 颈线突破确认，恢复持有/加仓'
          : pullbackTrigger != null ? '突破后回踩未有效跌破，重新收回确认' : '底部结构转强，允许从试仓切换到进攻仓位',
        `${trigger.structureId != null ? '低点' : '回踩'}容错 ${ADD_LOW_TOLERANCE_ATR.toFixed(1)} ATR，确认维度 ${confirmation.count}/3`,
        ...confirmation.reasons,
        distance != null ? `触发距离 ${distance.toFixed(1)} ATR` : null,
        ...auxiliaryScoreReason(score),
      ].filter((item): item is string => item != null))
      state.phase = 'bullish'
      if (validDefense(nextDefense, bar.close)) {
        raiseDefense(state, nextDefense, trigger.structure?.formationAtr ?? state.defenseAtr, trigger.structure?.latestLow ?? null)
      }
      state.positionStage = 'established'
      state.reducedThisSwing = false
      state.reduceIndex = null
      state.reduceSwingHigh = null
      state.reduceSwingLow = null
      state.lastActionIndex = index
      state.lastEventId = event.id
      if (trigger.structureId != null) state.usedStructureKeys.add(trigger.structureId)
      state.pendingAddBreakout = null
      state.bottomObservedAt = null
      state.topObservedAt = null
      state.extremeTopObservedAt = null
      state.topNeutralStreak = 0
      state.breakBelowDefenseStreak = 0
      state.defenseStatus = 'normal'
      state.defenseReference = null
    } else if (!stale && trialEntry && addCooldownReady(index, state.lastActionIndex, false) && pressure != null && trialDefenseCandidate != null && riskAtr != null) {
      const recoveringFromDefense = state.phase === 'defensive'
      const type: ActionSignalType = state.phase === 'wait' ? 'attack' : 'add'
      const bottomDistanceAtr = (bar.close - pressure.latestLow) / (features.atr ?? 1)
      const structureId = structure?.key ?? pressure.key
      event = createEvent(type, recoveringFromDefense ? 'recovery' : 'structure', period, bar, score, pressure.latestLow, trialDefenseCandidate.price, structureId, [
        type === 'attack'
          ? '超跌后空头动能衰竭，反转或结构改善确认，试仓'
          : recoveringFromDefense ? '防守期间再次出现底部反转，允许小幅回补' : '新的底部证据确认，回到加仓候选',
        ...lowerExhaustion.reasons,
        reversalEvidence != null ? `上涨反转：${reversalEvidence.label}` : `结构改善：${trialStructure.label}`,
        ...locationReasons(features, bar.close),
        `风险 ATR ${riskAtr.toFixed(1)}，距底部 ${bottomDistanceAtr.toFixed(1)} ATR`,
        `核心防守位 ${trialDefenseCandidate.price.toFixed(3)}`,
        ...auxiliaryScoreReason(score),
      ])
      state.phase = 'bullish'
      if (recoveringFromDefense) {
        raiseDefense(state, trialDefenseCandidate.price, features.atr, pressure.latestLow)
        state.positionStage = 'trial'
      } else {
        state.defensePrice = trialDefenseCandidate.price
        state.defenseAtr = features.atr
        state.defenseStructureLow = pressure.latestLow
        state.positionStage = type === 'attack' ? 'trial' : 'established'
        state.reducedThisSwing = false
        state.reduceIndex = null
        state.reduceSwingHigh = null
        state.reduceSwingLow = null
        state.defenseReference = null
      }
      state.lastActionIndex = index
      state.lastEventId = event.id
      state.breakBelowDefenseStreak = 0
      state.defenseStatus = 'normal'
      state.bottomObservedAt = null
      state.topObservedAt = null
      state.extremeTopObservedAt = null
      state.topNeutralStreak = 0
    }

    if (event) {
      state.pendingAddBreakout = null
      state.events.push(event)
    } else if (!stale) {
      if (!addBaseReady || (state.pendingAddBreakout != null && index - state.pendingAddBreakout.index > ADD_PULLBACK_MAX_AGE)) {
        state.pendingAddBreakout = null
      }
      if (addBaseReady
        && addTrigger != null
        && defenseAddTriggerAllowed
        && (addTrigger.trigger !== 'breakout' || (addConfirmationResult?.momentum === true && addConfirmationResult.volumePrice))) {
        state.pendingAddBreakout = {
          index,
          trigger: addTrigger.trigger,
          triggerPrice: addTrigger.triggerPrice,
          structureId: addTrigger.structureId,
          defensePrice: addTrigger.structure ? defenseFor(addTrigger.structure, features) : state.defensePrice,
          label: addTrigger.label,
        }
      }
    }
    state.history.push(historyState(state, bar, score, event))
  }

  const latestClosedDate = closedBars.at(-1)?.date ?? null
  const selected = selectStateAt(state.history, state.events, selectedDate, period)
  const latestFeatures = featureAt(closedBars, closedBars.length - 1, roc20Percentiles)
  const inputHasUnclosed = rows.at(-1)?.isClosed !== true
  const awaitingAddPullback = state.pendingAddBreakout != null
  const featuresUnavailable = !positive(latestFeatures.atr) || !positive(latestFeatures.ma20) || latestFeatures.position20 == null
  const status: ActionSignalStatus = stale ? 'stale' : inputHasUnclosed || featuresUnavailable ? 'provisional' : 'ready'
  const reason = stale
    ? '当前为过期快照，不确认新的行动信号。'
    : awaitingAddPullback
      ? `已出现${state.pendingAddBreakout!.label}，等待回踩不破并重新收回后加仓。`
    : inputHasUnclosed
      ? '当前 K 线尚未收盘，新的行动信号待收盘确认。'
      : featuresUnavailable
        ? '最新闭合 K 线基础指标不足，保留结构回放结果但暂不确认最新状态。'
        : '行动信号基于闭合 K 线、位置、动能/量价衰竭和价格结构；技术评分仅作辅助。'
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
    pendingConfirmation: inputHasUnclosed || awaitingAddPullback,
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
  if (action === 'reduce' || action === 'retreat' || action === 'defensive' || action === 'defense_test' || action === 'top_observe' || action === 'extreme_top_observe' || action === 'wait_defensive') return 'defensive'
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
