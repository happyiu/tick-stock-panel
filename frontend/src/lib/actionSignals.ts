import type {
  ChanlunAnalysis,
  ChanlunBarInput,
  ChanlunCandidateSignal,
} from './chanlun.ts'
import { analyzeChanlun } from './chanlun.ts'
import { buildPriceZones, type PriceZone } from './priceZones.ts'
import type { ChartDataStatus, KlinePeriod, TechnicalScoreRow, TechnicalScores } from './api.ts'

export const ACTION_SIGNAL_VERSION = 'action-signal-v1' as const
export const ACTION_SIGNAL_WARMUP_BARS = 60

export type ActionSignalType = 'attack' | 'add' | 'reduce' | 'retreat'
export type ActionPhase = 'wait' | 'bullish' | 'defensive'
export type ActionCurrentAction = ActionSignalType | 'hold' | 'defensive' | 'wait' | 'wait_defensive'
export type ActionSignalStatus = 'ready' | 'provisional' | 'blocked' | 'stale'
export type ActionSignalTrigger = 'breakout' | 'pullback' | 'structure' | 'support_break' | 'score_decay' | 'core_invalidation'

export interface ActionBar extends ChanlunBarInput {
  volume?: number | null
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

interface StructureSnapshot {
  analysis: ChanlunAnalysis
  zones: PriceZone[]
  candidate: ChanlunCandidateSignal | null
}

interface PendingPullback {
  id: string
  breakoutIndex: number
  level: number
  lower: number
  upper: number
  pullbackHigh: number | null
  confirmed: boolean
}

interface ReplayState {
  phase: ActionPhase
  defensePrice: number | null
  defenseSourceKey: string | null
  events: ActionSignalEvent[]
  history: ActionSignalState[]
  usedTriggerIds: Set<string>
  usedStructureIds: Set<string>
  weakScoreStreak: number
  reducedInRound: boolean
  lastAddOrRetreatIndex: number
  pendingPullback: PendingPullback | null
  lastEventId: string | null
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

function dateBeforeOrEqual(a: string, b: string, period: KlinePeriod): boolean {
  return normalizeKey(a, period) <= normalizeKey(b, period)
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

function strongBull(score: ActionScore, minimum: number): boolean {
  return score.available
    && score.direction != null && score.direction >= minimum
    && score.trend != null && score.trend >= 60
    && score.momentum != null && score.momentum >= 60
    && score.volumePrice != null && score.volumePrice >= 60
}

function scoreText(score: ActionScore): string {
  const values = [score.direction, score.trend, score.momentum, score.volumePrice]
  return values.every(finite) ? `方向${Math.round(score.direction!)} / 趋势${Math.round(score.trend!)} / 动能${Math.round(score.momentum!)} / 量价${Math.round(score.volumePrice!)}` : '技术评分尚未完整'
}

function structureCandidate(analysis: ChanlunAnalysis, bar: ActionBar, used: Set<string>): ChanlunCandidateSignal | null {
  return analysis.candidateSignals
    .filter(signal => signal.status === 'candidate')
    .filter(signal => signal.kind === 'second_buy' || signal.kind === 'third_buy')
    .filter(signal => dateBeforeOrEqual(signal.availableDate, bar.date, analysis.period))
    .filter(signal => signal.conditions.filter(item => item.id !== 'lower_level').every(item => item.state === 'met'))
    .filter(signal => !used.has(signal.id))
    .sort((a, b) => a.availableDate.localeCompare(b.availableDate))
    .at(-1) ?? null
}

interface DefenseCandidate {
  price: number | null
  sourceKey: string | null
}

function nearestBottom(analysis: ChanlunAnalysis, beforeDate: string, period: KlinePeriod): DefenseCandidate {
  const bottom = analysis.fractals
    .filter(item => item.type === 'bottom' && dateBeforeOrEqual(item.confirmedAt, beforeDate, period))
    .at(-1)
  return bottom
    ? { price: bottom.price, sourceKey: `bottom:${bottom.confirmedAt}:${bottom.price.toFixed(8)}` }
    : { price: null, sourceKey: null }
}

function fallbackRange(rows: ActionBar[], index: number, field: 'high' | 'low'): number | null {
  const values = rows.slice(Math.max(0, index - 20), index)
    .filter(row => row.isClosed === true)
    .map(row => row[field])
    .filter(positive)
  if (!values.length) return null
  return field === 'high' ? Math.max(...values) : Math.min(...values)
}

function previousZone(zones: PriceZone[], side: 'support' | 'resistance', price: number): PriceZone | null {
  return zones
    .filter(zone => zone.side === side)
    .filter(zone => side === 'support' ? zone.high < price : zone.low > price)
    .sort((a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity))
    .at(0) ?? null
}

function structureSnapshot(
  rows: ActionBar[],
  index: number,
  period: KlinePeriod,
  cache: Map<number, StructureSnapshot>,
): StructureSnapshot {
  const cached = cache.get(index)
  if (cached) return cached
  const bar = rows[index]
  const analysis = analyzeChanlun(rows as ChanlunBarInput[], bar.date, { period, source: 'stroke' })
  const snapshot = {
    analysis,
    zones: buildPriceZones(analysis),
    candidate: null,
  }
  cache.set(index, snapshot)
  return snapshot
}

function defenseFor(
  analysis: ChanlunAnalysis,
  candidate: ChanlunCandidateSignal | null,
  rows: ActionBar[],
  index: number,
): DefenseCandidate {
  const bar = rows[index]
  const atr = bar.atr14
  if (!positive(atr)) return { price: null, sourceKey: null }
  const bottom = nearestBottom(analysis, bar.date, analysis.period)
  const raw = candidate && positive(candidate.boundary)
    ? { price: candidate.boundary, sourceKey: `candidate:${candidate.id}` }
    : bottom.price != null
      ? bottom
      : { price: fallbackRange(rows, index, 'low'), sourceKey: null }
  return positive(raw.price) ? { price: raw.price - atr * 0.3, sourceKey: raw.sourceKey } : { price: null, sourceKey: raw.sourceKey }
}

function validDefense(value: number | null, close: number): value is number {
  return positive(value) && value < close
}

function createEvent(
  type: ActionSignalType,
  trigger: ActionSignalTrigger,
  period: KlinePeriod,
  bar: ActionBar,
  score: ActionScore,
  referencePrice: number | null,
  invalidationPrice: number | null,
  candidate: ChanlunCandidateSignal | null,
  reasons: string[],
): ActionSignalEvent {
  const candidatePart = candidate ? `structure:${candidate.id}` : ''
  return {
    id: `${type}:${bar.date}:${trigger}:${candidatePart}`,
    type,
    period,
    date: bar.date,
    confirmedAt: bar.date,
    score,
    trigger,
    referencePrice,
    invalidationPrice,
    structureSignalId: candidate?.id ?? null,
    structureMode: candidate ? 'structure_proxy' : 'price_event',
    reasons,
  }
}

function actionForPhase(phase: ActionPhase): ActionCurrentAction {
  if (phase === 'bullish') return 'hold'
  if (phase === 'defensive') return 'defensive'
  return 'wait'
}

function isWeakMarket(score: ActionScore): boolean {
  if (!score.available) return false
  return [score.direction, score.trend, score.momentum, score.volumePrice]
    .some(value => value != null && value <= 40)
}

function cloneScore(score: ActionScore): ActionScore {
  return { ...score }
}

function historyState(state: ReplayState, bar: ActionBar, score: ActionScore, event?: ActionSignalEvent): ActionSignalState {
  return {
    date: bar.date,
    phase: state.phase,
    action: event?.type ?? (state.phase === 'wait' && isWeakMarket(score) ? 'wait_defensive' : actionForPhase(state.phase)),
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
    nextConditions: ['至少需要 60 根已闭合 K 线及完整技术评分'],
    riskConditions: ['数据不足时不确认行动信号'],
  }
}

function triggerBreakout(
  rows: ActionBar[],
  index: number,
  previous: StructureSnapshot | null,
): { reference: number; id: string } | null {
  const bar = rows[index]
  const atr = bar.atr14
  if (!positive(atr) || !positive(bar.close) || !previous) return null
  const pressure = previousZone(previous.zones, 'resistance', rows[index - 1]?.close ?? bar.close)
  const reference = pressure?.high ?? fallbackRange(rows, index, 'high')
  if (!positive(reference)) return null
  const priorVolumes = rows.slice(Math.max(0, index - 5), index)
    .filter(row => row.isClosed === true)
    .map(row => row.volume)
    .filter(positive)
  if (priorVolumes.length < 5) return null
  const averageVolume = priorVolumes.reduce((sum, value) => sum + value, 0) / priorVolumes.length
  if (bar.close <= reference + atr * 0.2 || !positive(bar.volume) || bar.volume < averageVolume * 1.2) return null
  return { reference, id: `breakout:${bar.date}:${reference.toFixed(8)}` }
}

function updatePullback(
  pending: PendingPullback | null,
  rows: ActionBar[],
  index: number,
): { pending: PendingPullback | null; confirmed: boolean } {
  if (!pending || index <= pending.breakoutIndex) return { pending, confirmed: false }
  const bar = rows[index]
  if (bar.low < pending.lower) return { pending: null, confirmed: false }
  if (!pending.confirmed && bar.low <= pending.upper && bar.close >= pending.lower) {
    return { pending: { ...pending, pullbackHigh: bar.high, confirmed: true }, confirmed: false }
  }
  if (pending.confirmed && pending.pullbackHigh != null && bar.close > pending.pullbackHigh) {
    return { pending: null, confirmed: true }
  }
  return { pending, confirmed: false }
}

function nextConditions(phase: ActionPhase): string[] {
  if (phase === 'wait') return ['方向、趋势、动能、量价均达到 60', '有效突破压力位或完成二买/三买结构代理确认']
  if (phase === 'defensive') return ['技术分恢复且出现新的突破、回踩确认或结构代理事件', '重新确认防守位后再恢复多头阶段']
  return ['方向分达到 65，趋势、动能、量价均达到 60', '出现新的突破、突破后回踩确认或新的结构代理事件']
}

function riskConditions(phase: ActionPhase, defensePrice: number | null): string[] {
  if (defensePrice != null) return [`收盘跌破核心防守位 ${defensePrice.toFixed(3)} → 撤退`, '普通支撑破位且技术分连续走弱 → 减仓']
  if (phase === 'wait') return ['尚未建立多头阶段；结构失效时保持等待']
  return ['核心防守位暂不可用，暂不确认风险信号']
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
 * 按闭合 K 线顺序回放行动信号。结构分析固定使用 stroke source，
 * 每个截面只读取该截面以前的数据，确认日期记录在事件本身而不是结构发生日期。
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
  const structureCache = new Map<number, StructureSnapshot>()
  const state: ReplayState = {
    phase: 'wait',
    defensePrice: null,
    defenseSourceKey: null,
    events: [],
    history: [],
    usedTriggerIds: new Set(),
    usedStructureIds: new Set(),
    weakScoreStreak: 0,
    reducedInRound: false,
    lastAddOrRetreatIndex: -Infinity,
    pendingPullback: null,
    lastEventId: null,
  }
  let analysisStartDate: string | null = null

  for (let closedIndex = 0; closedIndex < closedBars.length; closedIndex += 1) {
    const bar = closedBars[closedIndex]
    const originalIndex = rows.indexOf(bar)
    if (closedIndex < ACTION_SIGNAL_WARMUP_BARS - 1) continue
    analysisStartDate ??= bar.date
    const score = scoreFor(scoreMap, bar, period)
    const currentStructure = structureSnapshot(rows, originalIndex, period, structureCache)
    currentStructure.candidate = structureCandidate(currentStructure.analysis, bar, state.usedStructureIds)
    const previousOriginalIndex = closedIndex > 0 ? rows.indexOf(closedBars[closedIndex - 1]) : -1
    const previousStructure = previousOriginalIndex >= 0 ? structureSnapshot(rows, previousOriginalIndex, period, structureCache) : null
    const previousClose = closedBars[closedIndex - 1]?.close ?? null
    const atr = positive(bar.atr14) ? bar.atr14 : null
    const breakout = triggerBreakout(rows, originalIndex, previousStructure)
    const pendingPullbackBefore = state.pendingPullback
    const pullbackUpdate = updatePullback(state.pendingPullback, closedBars, closedIndex)
    state.pendingPullback = pullbackUpdate.pending
    const pullbackConfirmed = pullbackUpdate.confirmed
    const structureCandidateValue = currentStructure.candidate
    const structureTrigger = structureCandidateValue && !state.usedStructureIds.has(structureCandidateValue.id)
    const breakoutTrigger = breakout && !state.usedTriggerIds.has(breakout.id)
    const addCooldownReady = closedIndex - state.lastAddOrRetreatIndex >= 5

    state.weakScoreStreak = score.available && score.direction != null && score.direction <= 40
      ? state.weakScoreStreak + 1
      : 0

    let event: ActionSignalEvent | undefined
    const coreInvalidation = state.phase !== 'wait'
      && positive(state.defensePrice)
      && bar.close < state.defensePrice
    const support = previousStructure ? previousZone(previousStructure.zones, 'support', previousClose ?? bar.close) : null
    const supportBreak = state.phase !== 'wait'
      && !!support
      && !!atr
      && bar.close < support.low - atr * 0.3

    if (!stale && coreInvalidation) {
      event = createEvent('retreat', 'core_invalidation', period, bar, score, state.defensePrice, state.defensePrice, null, [
        `收盘跌破核心防守位 ${state.defensePrice!.toFixed(3)}`,
        scoreText(score),
      ])
      state.phase = 'wait'
      state.defensePrice = null
      state.defenseSourceKey = null
      state.reducedInRound = false
      state.pendingPullback = null
      state.lastAddOrRetreatIndex = closedIndex
      state.lastEventId = event.id
    } else if (!stale && state.phase !== 'wait' && !state.reducedInRound && (state.weakScoreStreak >= 2 || supportBreak)) {
      const trigger: ActionSignalTrigger = state.weakScoreStreak >= 2 ? 'score_decay' : 'support_break'
      event = createEvent('reduce', trigger, period, bar, score, support?.low ?? null, state.defensePrice, null, [
        trigger === 'score_decay' ? '技术方向连续两根闭合 K 线不高于 40 分' : `收盘跌破最近支撑区 ${support?.low.toFixed(3)}`,
        scoreText(score),
      ])
      state.phase = 'defensive'
      state.reducedInRound = true
      state.lastEventId = event.id
    } else if (!stale && score.available && addCooldownReady && strongBull(score, 65) && state.phase !== 'wait'
      && (breakoutTrigger || pullbackConfirmed || structureTrigger)) {
      const trigger: ActionSignalTrigger = pullbackConfirmed ? 'pullback' : structureTrigger ? 'structure' : 'breakout'
      const reference = pullbackConfirmed
        ? pendingPullbackBefore?.level ?? null
        : breakout?.reference ?? structureCandidateValue?.price ?? null
      const eventCandidate = trigger === 'structure' ? structureCandidateValue : null
      event = createEvent('add', trigger, period, bar, score, reference, state.defensePrice, eventCandidate, [
        trigger === 'pullback' ? '突破后回踩确认并重新向上' : trigger === 'structure' ? `完成${structureCandidateValue?.kind === 'third_buy' ? '三买' : '二买'}结构代理条件` : '收盘有效突破压力位并放量',
        scoreText(score),
      ])
      state.phase = 'bullish'
      state.reducedInRound = false
      state.lastAddOrRetreatIndex = closedIndex
      state.lastEventId = event.id
      if (eventCandidate) state.usedStructureIds.add(eventCandidate.id)
      if (breakout) state.usedTriggerIds.add(breakout.id)
    } else if (!stale && score.available && addCooldownReady && strongBull(score, 60) && state.phase === 'wait'
      && (breakoutTrigger || structureTrigger)) {
      const trigger: ActionSignalTrigger = structureTrigger ? 'structure' : 'breakout'
      const reference = breakout?.reference ?? structureCandidateValue?.price ?? null
      const defenseCandidate = defenseFor(currentStructure.analysis, structureCandidateValue, rows, originalIndex)
      if (validDefense(defenseCandidate.price, bar.close)) {
        const eventCandidate = trigger === 'structure' ? structureCandidateValue : null
        event = createEvent('attack', trigger, period, bar, score, reference, defenseCandidate.price, eventCandidate, [
          trigger === 'structure' ? `完成${structureCandidateValue?.kind === 'third_buy' ? '三买' : '二买'}结构代理条件` : '收盘有效突破压力位并放量',
          scoreText(score),
          `核心防守位 ${defenseCandidate.price.toFixed(3)}`,
        ])
        state.phase = 'bullish'
        state.defensePrice = defenseCandidate.price
        state.defenseSourceKey = defenseCandidate.sourceKey
        state.reducedInRound = false
        state.lastEventId = event.id
        if (eventCandidate) state.usedStructureIds.add(eventCandidate.id)
        if (breakout) state.usedTriggerIds.add(breakout.id)
      }
    }

    if (state.phase !== 'wait' && state.defensePrice != null) {
      const candidateDefense = defenseFor(currentStructure.analysis, structureCandidateValue, rows, originalIndex)
      if (candidateDefense.sourceKey
        && candidateDefense.sourceKey !== state.defenseSourceKey
        && validDefense(candidateDefense.price, bar.close)
        && candidateDefense.price > state.defensePrice) {
        state.defensePrice = candidateDefense.price
        state.defenseSourceKey = candidateDefense.sourceKey
      }
    }

    if (breakout && !state.usedTriggerIds.has(breakout.id)) {
      state.pendingPullback = {
        id: breakout.id,
        breakoutIndex: closedIndex,
        level: breakout.reference,
        lower: breakout.reference - (atr ?? 0) * 0.3,
        upper: breakout.reference + (atr ?? 0) * 0.3,
        pullbackHigh: null,
        confirmed: false,
      }
    }
    if (event) state.events.push(event)
    const stateEvent = event
    state.history.push(historyState(state, bar, score, stateEvent))
  }

  const latestClosedDate = closedBars.at(-1)?.date ?? null
  const selected = selectStateAt(state.history, state.events, selectedDate, period)
  const latestScore = latestClosedDate ? scoreMap.get(normalizeKey(latestClosedDate, period)) ?? null : null
  const inputHasUnclosed = rows.at(-1)?.isClosed !== true
  const scoreUnavailable = !latestScore?.available
  const status: ActionSignalStatus = stale ? 'stale' : inputHasUnclosed || scoreUnavailable ? 'provisional' : 'ready'
  const reason = stale
    ? '当前为过期快照，不确认新的行动信号。'
    : inputHasUnclosed
      ? '当前 K 线尚未收盘，新的行动信号待收盘确认。'
      : scoreUnavailable
        ? '最新闭合 K 线技术评分不完整，暂不确认新的行动信号。'
        : '行动信号仅基于闭合 K 线和结构代理回放。'
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
    pendingConfirmation: inputHasUnclosed || !!state.pendingPullback,
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
    attack: '进攻',
    add: '加仓',
    reduce: '减仓',
    retreat: '撤退',
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
  if (action === 'reduce' || action === 'retreat' || action === 'defensive' || action === 'wait_defensive') return 'defensive'
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
