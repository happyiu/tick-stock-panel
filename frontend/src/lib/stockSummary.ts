import type {
  ChartDataStatus,
  KlinePeriod,
  KlineRow,
  TechnicalScoreRow,
  TechnicalScores,
} from '@/lib/api'
import type { ElliottAnalysis } from '@/lib/elliott'
import type {
  ChanlunAnalysis,
  ChanlunCandidateKind,
  ChanlunCandidateSignal,
  ChanlunCondition,
  ChanlunConditionState,
} from '@/lib/chanlun'
import type { PriceZone } from '@/lib/priceZones'
import type { SignalRiskContext } from '@/lib/signalRisk'
import type { ActionSignalComparison, ActionSignalResult } from '@/lib/actionSignals'

export type StockSummaryQuality = 'ready' | 'limited' | 'blocked'
export type StockSummaryTone = 'bull' | 'bear' | 'neutral' | 'warning'
export type StockSummaryObservation =
  | 'observe'
  | 'waiting_confirmation'
  | 'conflict'
  | 'invalidated'
  | 'unavailable'

export type StockDecisionState = 'buy' | 'probe' | 'wait' | 'reduce' | 'sell'
export type StockDecisionInputState = 'ready' | 'provisional' | 'blocked'

export type StockSummaryEvidenceSource = 'quality' | 'technical' | 'structure' | 'wave' | 'level' | 'risk'

export interface StockSummaryEvidence {
  id: string
  source: StockSummaryEvidenceSource
  label: string
  text: string
  tone: StockSummaryTone
  targetId?: string
}

export interface StockSummaryCondition {
  id: string
  label: string
  state: ChanlunConditionState | 'unavailable'
  text: string
  sourceId?: string
  targetId?: string
}

export interface StockSummaryConflict {
  id: string
  label: string
  text: string
  directions: Array<'bull' | 'bear' | 'neutral'>
}

export interface StockSummaryTechnical {
  score: number | null
  confidence: number | null
  coverage: number | null
  trend: number | null
  momentum: number | null
  volumePrice: number | null
  volatilityRisk: number | null
  activity: number | null
  direction: string
  directionTone: StockSummaryTone
  dimensionLabels: {
    trend: string
    momentum: string
    volumePrice: string
  }
}

export interface StockSummaryStructure {
  trendType: ChanlunAnalysis['trendType']
  trendLabel: string
  stateLabel: string
  direction: 'bull' | 'bear' | 'neutral'
  definitionMode: ChanlunAnalysis['definitionMode']
  source: ChanlunAnalysis['source']
  candidateCount: number
  activeCandidate: ChanlunCandidateSignal | null
  approximationLoss: string
}

export interface StockSummaryQualityInfo {
  status: StockSummaryQuality
  label: string
  reasons: string[]
  stale: boolean
  dataThrough: string | null
  latestBarClosed: boolean | null
}

export interface StockSummaryDecision {
  state: StockDecisionState
  flatAction: '买入' | '试仓' | '等待' | '暂不介入'
  holdingAction: '持有' | '持有观察' | '减仓' | '卖出'
  inputState: StockDecisionInputState
  reason: string
  upgradeConditions: StockSummaryCondition[]
  riskConditions: StockSummaryCondition[]
}

export interface StockSummaryContext {
  symbol: string
  name?: string
  assetType?: 'stock' | 'etf' | 'index'
  period: KlinePeriod
  asOf: string | null
  windowStart: string | null
  windowEnd: string | null
  bars: number
  priceBasis: '前复权' | '未知'
  historical: boolean
  dataStatus?: ChartDataStatus
}

export interface StockSummarySnapshot {
  context: StockSummaryContext
  quality: StockSummaryQualityInfo
  versions: {
    summary: 'stock-summary-v1'
    decision: 'stock-decision-v1'
    technical: string | null
    structure: number | null
    levels: string | null
    risk: string | null
    wave: string | null
  }
  technical: StockSummaryTechnical
  structure: StockSummaryStructure
  observation: {
    status: StockSummaryObservation
    label: string
    tone: StockSummaryTone
  }
  decision: StockSummaryDecision
  headline: string
  summary: string
  supportingEvidence: StockSummaryEvidence[]
  opposingEvidence: StockSummaryEvidence[]
  conflicts: StockSummaryConflict[]
  conditions: StockSummaryCondition[]
  invalidation: StockSummaryCondition[]
  levels: {
    support: PriceZone | null
    resistance: PriceZone | null
    current: PriceZone | null
  }
  risk: {
    status: SignalRiskContext['status'] | 'unavailable'
    referencePrice: number | null
    invalidation: number | null
    target1: PriceZone | null
    riskReward1: number | null
    reason?: string
  }
  limitations: string[]
  action?: ActionSignalResult | null
  actionComparison?: ActionSignalComparison | null
}

export interface StockSummaryInput {
  symbol: string
  name?: string
  assetType?: 'stock' | 'etf' | 'index'
  period: KlinePeriod
  rows: KlineRow[]
  technicalScores?: TechnicalScores
  dataStatus?: ChartDataStatus
  /** API response source; enriched means the chart snapshot fell back to local canonical data. */
  dataSource?: string
  selectedBarKey?: string | null
  chanlun: ChanlunAnalysis
  elliott: ElliottAnalysis
  priceZones: PriceZone[]
  signalRiskContexts: SignalRiskContext[]
  preferredSignal: SignalRiskContext | null
  actionSignals?: ActionSignalResult | null
  actionComparison?: ActionSignalComparison | null
}

const PERIOD_LABELS: Record<KlinePeriod, string> = {
  '30m': '30F',
  '1d': '日K',
  '1w': '周K',
  '1mo': '月K',
}

const TREND_LABELS: Record<ChanlunAnalysis['trendType'], string> = {
  uptrend_proxy: '上涨趋势近似',
  downtrend_proxy: '下跌趋势近似',
  consolidation_proxy: '盘整近似',
  unclear: '结构不明',
}

const CENTER_LABELS: Record<string, string> = {
  oscillating: '中枢震荡',
  extension: '中枢延伸',
  newborn: '中枢新生',
  broken_up: '向上离开',
  broken_down: '向下离开',
}

const SIGNAL_LABELS: Record<ChanlunCandidateKind, string> = {
  first_buy: '一买候选',
  second_buy: '二买候选',
  third_buy: '三买候选',
  first_sell: '一卖候选',
  second_sell: '二卖候选',
  third_sell: '三卖候选',
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeKey(value: string | null | undefined, period: KlinePeriod): string {
  if (!value) return ''
  const normalized = value.replace('T', ' ')
  return period === '30m' ? normalized.slice(0, 16) : normalized.slice(0, 10)
}

function latestRow(rows: KlineRow[], selectedBarKey: string | null | undefined, period: KlinePeriod): KlineRow | null {
  if (!rows.length) return null
  if (selectedBarKey) {
    const selected = normalizeKey(selectedBarKey, period)
    return rows.find(row => normalizeKey(row.date, period) === selected) ?? null
  }
  return rows.at(-1) ?? null
}

function scoreForSelection(
  scores: TechnicalScores | undefined,
  rows: KlineRow[],
  selectedBarKey: string | null | undefined,
  period: KlinePeriod,
): TechnicalScoreRow | null {
  const values = scores?.rows ?? []
  if (!values.length) return null
  const selected = selectedBarKey ? normalizeKey(selectedBarKey, period) : normalizeKey(rows.at(-1)?.date, period)
  return values.find(row => normalizeKey(row.as_of, period) === selected) ?? null
}

function scoreLabel(value: number | null): { label: string; tone: StockSummaryTone } {
  if (!finite(value)) return { label: '未评估', tone: 'neutral' }
  if (value >= 60) return { label: '偏强', tone: 'bull' }
  if (value <= 40) return { label: '偏弱', tone: 'bear' }
  return { label: '中性', tone: 'neutral' }
}

function scoreDimensionLabel(value: number | null): string {
  if (!finite(value)) return '未评估'
  if (value >= 60) return '改善'
  if (value <= 40) return '偏弱'
  return '中性'
}

function directionFromTrend(trend: ChanlunAnalysis['trendType']): 'bull' | 'bear' | 'neutral' {
  return trend === 'uptrend_proxy' ? 'bull' : trend === 'downtrend_proxy' ? 'bear' : 'neutral'
}

function signalDirection(signal: ChanlunCandidateSignal | null): 'bull' | 'bear' | 'neutral' {
  if (!signal) return 'neutral'
  return signal.kind.endsWith('_buy') ? 'bull' : 'bear'
}

function conditionText(item: ChanlunCondition): string {
  return item.evidence || item.label
}

function conditionStateLabel(state: ChanlunConditionState): string {
  return state === 'met' ? '满足' : state === 'failed' ? '不满足' : state === 'waiting' ? '等待' : '数据不足'
}

function activeSignal(contexts: SignalRiskContext[], preferred: SignalRiskContext | null): SignalRiskContext | null {
  const active = contexts.filter(context => context.signal.status === 'candidate' || context.signal.status === 'waiting_pullback')
  if (preferred && active.some(context => context.signal.id === preferred.signal.id)) return preferred
  return active[0] ?? null
}

function latestSignalContext(contexts: SignalRiskContext[]): SignalRiskContext | null {
  return [...contexts].sort((a, b) => b.signal.availableDate.localeCompare(a.signal.availableDate))[0] ?? null
}

function nearestZone(zones: PriceZone[], side: PriceZone['side']): PriceZone | null {
  return zones
    .filter(zone => zone.side === side)
    .sort((a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity))[0] ?? null
}

function buildQuality(
  input: StockSummaryInput,
  row: KlineRow | null,
  score: TechnicalScoreRow | null,
): StockSummaryQualityInfo {
  const reasons: string[] = []
  if (!row) reasons.push(input.selectedBarKey ? '选中的观察时点没有对应 K 线' : '暂无当前周期 K 线')
  if (row && row.is_closed !== true) reasons.push('末根 K 线尚未闭合或闭合状态未知')
  if (!score || !score.available) reasons.push('当前观察时点技术评分不可用')
  if (input.chanlun.status !== 'ready') reasons.push(...input.chanlun.issues.slice(0, 1))
  if (input.elliott.status !== 'ready') reasons.push(...input.elliott.dataQuality.limitations.slice(0, 1))
  const staleSnapshot = input.dataStatus?.stale === true
  const enrichedFallback = staleSnapshot && input.dataSource === 'enriched'
  if (enrichedFallback) reasons.push('展示行情源暂不可用，当前使用本地 enriched 数据')
  else if (staleSnapshot) reasons.push('行情展示缓存为过期快照')
  const stale = staleSnapshot && !enrichedFallback
  const uniqueReasons = [...new Set(reasons.filter(Boolean))]
  const status: StockSummaryQuality = !row
    ? 'blocked'
    : uniqueReasons.length > 0 ? 'limited' : 'ready'
  return {
    status,
    label: status === 'ready' ? '数据完整' : status === 'limited' ? '部分可用' : '暂不可用',
    reasons: uniqueReasons,
    stale,
    dataThrough: input.dataStatus?.data_through ?? null,
    latestBarClosed: row?.is_closed ?? null,
  }
}

function buildTechnical(score: TechnicalScoreRow | null): StockSummaryTechnical {
  const scoreValue = finite(score?.direction_score) ? score.direction_score : null
  const direction = scoreLabel(scoreValue)
  return {
    score: scoreValue,
    confidence: finite(score?.confidence) ? score.confidence : null,
    coverage: finite(score?.coverage) ? score.coverage : null,
    trend: finite(score?.trend) ? score.trend : null,
    momentum: finite(score?.momentum) ? score.momentum : null,
    volumePrice: finite(score?.volume_price) ? score.volume_price : null,
    volatilityRisk: finite(score?.volatility_risk) ? score.volatility_risk : null,
    activity: finite(score?.activity) ? score.activity : null,
    direction: direction.label,
    directionTone: direction.tone,
    dimensionLabels: {
      trend: scoreDimensionLabel(finite(score?.trend) ? score.trend : null),
      momentum: scoreDimensionLabel(finite(score?.momentum) ? score.momentum : null),
      volumePrice: scoreDimensionLabel(finite(score?.volume_price) ? score.volume_price : null),
    },
  }
}

function buildStructure(analysis: ChanlunAnalysis, signal: SignalRiskContext | null): StockSummaryStructure {
  const center = analysis.latestCenter
  const stateLabel = center ? CENTER_LABELS[center.state] ?? '结构状态未定义' : '尚未形成中枢'
  return {
    trendType: analysis.trendType,
    trendLabel: TREND_LABELS[analysis.trendType],
    stateLabel,
    direction: signalDirection(signal?.signal ?? null) === 'neutral' ? directionFromTrend(analysis.trendType) : signalDirection(signal?.signal ?? null),
    definitionMode: analysis.definitionMode,
    source: analysis.source,
    candidateCount: analysis.candidateSignals.length,
    activeCandidate: signal?.signal ?? null,
    approximationLoss: analysis.approximationLoss,
  }
}

function buildConflicts(
  technical: StockSummaryTechnical,
  structure: StockSummaryStructure,
  elliott: ElliottAnalysis,
): StockSummaryConflict[] {
  const conflicts: StockSummaryConflict[] = []
  const technicalDirection = technical.directionTone
  // 结构趋势与候选信号分开比较：候选可能是逆趋势观察，不能覆盖趋势本身。
  const trendDirection = directionFromTrend(structure.trendType)
  const structureDirection = trendDirection === 'neutral' ? structure.direction : trendDirection
  if ((technicalDirection === 'bull' && structureDirection === 'bear') || (technicalDirection === 'bear' && structureDirection === 'bull')) {
    conflicts.push({
      id: 'technical-structure-direction',
      label: '技术与结构分歧',
      text: `技术评分${technical.direction}，结构方向${structureDirection === 'bull' ? '偏多' : '偏空'}；当前不能用单一维度升级结论。`,
      directions: [technicalDirection, structureDirection],
    })
  }
  const waveDirection = elliott.primaryCount?.direction
  const waveTone: 'bull' | 'bear' | 'neutral' = waveDirection === 'up' ? 'bull' : waveDirection === 'down' ? 'bear' : 'neutral'
  if (waveTone !== 'neutral' && structureDirection !== 'neutral' && waveTone !== structureDirection) {
    conflicts.push({
      id: 'wave-structure-direction',
      label: '波浪与结构分歧',
      text: `本地波浪代理偏${waveTone === 'bull' ? '多' : '空'}，缠论结构偏${structureDirection === 'bull' ? '多' : '空'}；波浪计数${elliott.ambiguity === 'multiple_viable' ? '存在多个可行候选' : '仍属代理分析'}。`,
      directions: [waveTone, structureDirection],
    })
  }
  return conflicts
}

function buildObservation(
  quality: StockSummaryQualityInfo,
  conflicts: StockSummaryConflict[],
  active: SignalRiskContext | null,
  latest: SignalRiskContext | null,
): { status: StockSummaryObservation; label: string; tone: StockSummaryTone } {
  if (quality.status === 'blocked') return { status: 'unavailable', label: '数据不足', tone: 'neutral' }
  if (latest && !active && (latest.signal.status === 'invalidated' || latest.signal.status === 'rejected')) {
    return { status: 'invalidated', label: latest.signal.status === 'invalidated' ? '候选已失效' : '候选不成立', tone: 'bear' }
  }
  if (conflicts.length > 0) return { status: 'conflict', label: '存在分歧', tone: 'warning' }
  if (active) return { status: 'waiting_confirmation', label: active.signal.status === 'candidate' ? '候选观察' : '等待确认', tone: 'warning' }
  return { status: 'observe', label: '观察', tone: 'neutral' }
}

function shortSignalLabel(signal: ChanlunCandidateSignal | null): string {
  return signal ? SIGNAL_LABELS[signal.kind] : '无有效候选'
}

function dedupeEvidence(items: StockSummaryEvidence[]): StockSummaryEvidence[] {
  const seen = new Set<string>()
  return items.filter(item => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

function buildEvidence(
  input: StockSummaryInput,
  technical: StockSummaryTechnical,
  structure: StockSummaryStructure,
  active: SignalRiskContext | null,
  support: PriceZone | null,
  resistance: PriceZone | null,
  risk: StockSummarySnapshot['risk'],
): { supporting: StockSummaryEvidence[]; opposing: StockSummaryEvidence[] } {
  const supporting: StockSummaryEvidence[] = []
  const opposing: StockSummaryEvidence[] = []
  if (technical.score != null && technical.score >= 60) {
    supporting.push({ id: 'technical-direction', source: 'technical', label: '技术方向', text: `技术方向分 ${technical.score}，当前判断为${technical.direction}。`, tone: 'bull' })
  } else if (technical.score != null && technical.score <= 40) {
    opposing.push({ id: 'technical-direction', source: 'technical', label: '技术方向', text: `技术方向分 ${technical.score}，当前判断为${technical.direction}。`, tone: 'bear' })
  }
  if (technical.momentum != null && technical.momentum >= 60) {
    supporting.push({ id: 'technical-momentum', source: 'technical', label: '动能', text: `动能维度 ${technical.momentum} 分，状态为${technical.dimensionLabels.momentum}。`, tone: 'bull' })
  } else if (technical.momentum != null && technical.momentum <= 40) {
    opposing.push({ id: 'technical-momentum', source: 'technical', label: '动能', text: `动能维度 ${technical.momentum} 分，状态为${technical.dimensionLabels.momentum}。`, tone: 'bear' })
  }
  if (technical.volumePrice != null && technical.volumePrice < 50) {
    opposing.push({ id: 'technical-volume-price', source: 'technical', label: '量价', text: `量价维度 ${technical.volumePrice} 分，量价配合不足。`, tone: 'bear' })
  } else if (technical.volumePrice != null && technical.volumePrice >= 60) {
    supporting.push({ id: 'technical-volume-price', source: 'technical', label: '量价', text: `量价维度 ${technical.volumePrice} 分，量价配合较好。`, tone: 'bull' })
  }
  if (structure.direction === 'bull') {
    supporting.push({ id: 'structure-state', source: 'structure', label: '结构', text: `${structure.trendLabel}，${structure.stateLabel}。`, tone: 'bull' })
  } else if (structure.direction === 'bear') {
    opposing.push({ id: 'structure-state', source: 'structure', label: '结构', text: `${structure.trendLabel}，${structure.stateLabel}。`, tone: 'bear' })
  } else if (input.chanlun.status === 'ready') {
    supporting.push({ id: 'structure-state', source: 'structure', label: '结构', text: `${structure.trendLabel}，${structure.stateLabel}，方向尚不明确。`, tone: 'neutral' })
  }
  if (active) {
    supporting.push({
      id: `signal-${active.signal.id}`,
      source: 'structure',
      label: '结构候选',
      text: `存在${shortSignalLabel(active.signal)}，最早可知于 ${active.signal.availableDate.slice(0, 16).replace('T', ' ')}；低级别触发仍缺失。`,
      tone: active.direction === 'buy' ? 'bull' : 'bear',
      targetId: active.signal.id,
    })
  } else if (input.chanlun.status === 'ready') {
    opposing.push({ id: 'structure-candidate', source: 'structure', label: '结构候选', text: '当前周期暂无有效的一、二、三类候选。', tone: 'neutral' })
  }
  if (support) {
    supporting.push({ id: `support-${support.id}`, source: 'level', label: '支撑', text: `当前下方最近支撑区间 ${support.low.toFixed(3)} ~ ${support.high.toFixed(3)}。`, tone: 'bull', targetId: support.id })
  }
  if (resistance) {
    opposing.push({ id: `resistance-${resistance.id}`, source: 'level', label: '压力', text: `当前上方最近压力区间 ${resistance.low.toFixed(3)} ~ ${resistance.high.toFixed(3)}。`, tone: 'bear', targetId: resistance.id })
  }
  if (risk.status === 'calculable' && risk.riskReward1 != null) {
    const tone: StockSummaryTone = risk.riskReward1 >= 2 ? 'bull' : 'warning'
    supporting.push({ id: 'signal-risk', source: 'risk', label: '结构空间', text: `当前候选目标一与失效边界的空间比为 1 : ${risk.riskReward1.toFixed(2)}。`, tone, targetId: active?.signal.id })
  } else if (active && risk.reason) {
    opposing.push({ id: 'signal-risk-unavailable', source: 'risk', label: '结构空间', text: `风险空间暂不可计算：${risk.reason}。`, tone: 'warning', targetId: active.signal.id })
  }
  return { supporting: dedupeEvidence(supporting), opposing: dedupeEvidence(opposing) }
}

function buildConditions(active: SignalRiskContext | null): StockSummaryCondition[] {
  if (!active) return []
  return active.signal.conditions.map(item => ({
    id: item.id,
    label: item.label,
    state: item.state,
    text: `${conditionStateLabel(item.state)}：${conditionText(item)}`,
    sourceId: active.signal.id,
  }))
}

function scoreGate(
  id: string,
  label: string,
  value: number | null,
  threshold: number,
  direction: 'min' | 'max',
): StockSummaryCondition {
  if (value == null) {
    return { id, label, state: 'unavailable', text: '当前评分不可用' }
  }
  const met = direction === 'min' ? value >= threshold : value <= threshold
  return {
    id,
    label,
    state: met ? 'met' : 'failed',
    text: `当前 ${Math.round(value)} 分，${met ? '已达到' : '尚未达到'} ${direction === 'min' ? '≥' : '≤'}${threshold}`,
  }
}

function riskGate(risk: StockSummarySnapshot['risk']): StockSummaryCondition {
  if (risk.status !== 'calculable' || risk.riskReward1 == null) {
    return {
      id: 'decision-risk-space',
      label: '结构空间 ≥ 1 : 2',
      state: 'unavailable',
      text: risk.reason ?? '目标一或失效边界不可计算',
    }
  }
  const met = risk.riskReward1 >= 2
  return {
    id: 'decision-risk-space',
    label: '结构空间 ≥ 1 : 2',
    state: met ? 'met' : 'failed',
    text: `当前目标一 / 风险为 1 : ${risk.riskReward1.toFixed(2)}，${met ? '达到' : '低于'}门槛`,
  }
}

function decisionInputState(
  input: StockSummaryInput,
  row: KlineRow | null,
  score: TechnicalScoreRow | null,
): StockDecisionInputState {
  const scoreReady = score?.available === true
    && [score.direction_score, score.trend, score.momentum, score.volume_price].every(finite)
  if (!row || !scoreReady || input.chanlun.status !== 'ready') return 'blocked'
  const staleSnapshot = input.dataStatus?.stale === true && input.dataSource !== 'enriched'
  if (row.is_closed !== true || staleSnapshot) return 'provisional'
  return 'ready'
}

function nonLowerConditionsReady(signal: ChanlunCandidateSignal): boolean {
  return signal.conditions
    .filter(item => item.id !== 'lower_level')
    .every(item => item.state === 'met')
}

function allSignalConditionsReady(signal: ChanlunCandidateSignal): boolean {
  return signal.conditions.every(item => item.state === 'met')
}

function lowerLevelCanBeMissing(signal: ChanlunCandidateSignal): boolean {
  const lower = signal.conditions.find(item => item.id === 'lower_level')
  return !lower || lower.state === 'waiting' || lower.state === 'unavailable'
}

function lowerLevelConfirmed(signal: ChanlunCandidateSignal): boolean {
  return signal.conditions.find(item => item.id === 'lower_level')?.state === 'met'
}

function buildDecisionConditions(
  technical: StockSummaryTechnical,
  active: SignalRiskContext | null,
  latest: SignalRiskContext | null,
  conditions: StockSummaryCondition[],
  risk: StockSummarySnapshot['risk'],
  support: PriceZone | null,
): Pick<StockSummaryDecision, 'upgradeConditions' | 'riskConditions'> {
  const upgradeConditions: StockSummaryCondition[] = []
  const riskConditions: StockSummaryCondition[] = []
  const signal = active?.signal

  if (signal?.status === 'candidate' && active?.direction === 'buy') {
    upgradeConditions.push(...conditions.filter(item => item.state !== 'met'))
    if (signal.kind !== 'first_buy') {
      upgradeConditions.push(
        scoreGate('decision-direction-score', '技术方向 ≥ 60', technical.score, 60, 'min'),
        scoreGate('decision-trend-score', '趋势 ≥ 60', technical.trend, 60, 'min'),
        scoreGate('decision-momentum-score', '动能 ≥ 60', technical.momentum, 60, 'min'),
        scoreGate('decision-volume-price-score', '量价 ≥ 60', technical.volumePrice, 60, 'min'),
        riskGate(risk),
      )
    }
    if (risk.invalidation != null) {
      riskConditions.push({
        id: 'decision-buy-invalidation',
        label: '买侧失效位',
        state: 'waiting',
        text: `触及 ${risk.invalidation.toFixed(3)} 时，买侧候选需要重新评估。`,
        sourceId: signal.id,
      })
    }
  } else if (signal?.status === 'candidate' && active?.direction === 'sell') {
    upgradeConditions.push({
      id: 'decision-sell-recovery',
      label: '卖侧风险缓解',
      state: 'waiting',
      text: risk.invalidation != null
        ? `价格重新站回 ${risk.invalidation.toFixed(3)} 上方后再评估卖侧候选。`
        : '卖侧候选失效后再重新评估。',
      sourceId: signal.id,
    })
    upgradeConditions.push(scoreGate('decision-recovery-score', '技术方向恢复 ≥ 60', technical.score, 60, 'min'))
    riskConditions.push({
      id: `decision-sell-signal-${signal.id}`,
      label: '卖侧结构',
      state: 'met',
      text: `当前存在${shortSignalLabel(signal)}，仅作为当前周期风险信号。`,
      sourceId: signal.id,
    })
    if (risk.invalidation != null) {
      riskConditions.push({
        id: 'decision-sell-invalidation',
        label: '卖侧失效 / 风险缓解位',
        state: 'waiting',
        text: `价格重新站回 ${risk.invalidation.toFixed(3)} 上方时，卖侧候选需要重新评估。`,
        sourceId: signal.id,
      })
    }
  } else if (signal?.status === 'waiting_pullback') {
    upgradeConditions.push(...conditions.filter(item => item.state !== 'met'))
    upgradeConditions.push({
      id: 'decision-pullback-confirmation',
      label: '回抽确认',
      state: 'waiting',
      text: signal.nextWatch,
      sourceId: signal.id,
    })
  } else {
    upgradeConditions.push({
      id: 'decision-buy-candidate',
      label: '买侧结构候选',
      state: 'waiting',
      text: '当前周期尚未形成可升级的买侧候选。',
    })
    if (latest && (latest.signal.status === 'invalidated' || latest.signal.status === 'rejected')) {
      riskConditions.push({
        id: `decision-latest-${latest.signal.id}`,
        label: '最近候选状态',
        state: 'failed',
        text: `最近${shortSignalLabel(latest.signal)}已${latest.signal.status === 'invalidated' ? '失效' : '不成立'}。`,
        sourceId: latest.signal.id,
      })
    }
  }

  if (support && riskConditions.length < 3) {
    riskConditions.push({
      id: `decision-support-${support.id}`,
      label: '最近支撑观察区',
      state: 'waiting',
      text: '跌破该区间仅作为风险观察，不替代候选的结构失效边界。',
      targetId: support.id,
    })
  }

  return {
    upgradeConditions: [...new Map(upgradeConditions.map(item => [item.id, item])).values()].slice(0, 5),
    riskConditions: [...new Map(riskConditions.map(item => [item.id, item])).values()].slice(0, 5),
  }
}

function buildDecision(
  input: StockSummaryInput,
  row: KlineRow | null,
  score: TechnicalScoreRow | null,
  technical: StockSummaryTechnical,
  structure: StockSummaryStructure,
  active: SignalRiskContext | null,
  latest: SignalRiskContext | null,
  conflicts: StockSummaryConflict[],
  conditions: StockSummaryCondition[],
  risk: StockSummarySnapshot['risk'],
  support: PriceZone | null,
): StockSummaryDecision {
  const inputState = decisionInputState(input, row, score)
  const signal = active?.signal
  const isCandidate = signal?.status === 'candidate'
  const isBuyCandidate = isCandidate && active?.direction === 'buy'
  const isFollowupBuyCandidate = isBuyCandidate && (signal?.kind === 'second_buy' || signal?.kind === 'third_buy')
  const isSellCandidate = isCandidate && active?.direction === 'sell'
  const structureReady = !!signal && nonLowerConditionsReady(signal)
  const lowerMissingAllowed = !!signal && lowerLevelCanBeMissing(signal)
  const lowerConfirmed = !!signal && lowerLevelConfirmed(signal)
  const allReady = !!signal && allSignalConditionsReady(signal)
  const strongBull = technical.score != null
    && technical.trend != null
    && technical.momentum != null
    && technical.volumePrice != null
    && technical.score >= 60
    && technical.trend >= 60
    && technical.momentum >= 60
    && technical.volumePrice >= 60
  const strongBear = technical.score != null
    && technical.trend != null
    && technical.momentum != null
    && technical.volumePrice != null
    && technical.score <= 40
    && technical.trend <= 40
    && technical.momentum <= 40
    && technical.volumePrice <= 40
  const noConflict = conflicts.length === 0
  const riskReady = risk.status === 'calculable' && risk.riskReward1 != null && risk.riskReward1 >= 2

  let state: StockDecisionState = 'wait'
  if (inputState === 'ready' && noConflict) {
    if (isSellCandidate && allReady && lowerConfirmed && strongBear && structure.direction === 'bear') {
      state = 'sell'
    } else if (isSellCandidate && structureReady && lowerMissingAllowed
      && (technical.score != null && technical.score <= 40 || structure.trendType === 'downtrend_proxy')
      && !strongBull
      && structure.direction === 'bear') {
      state = 'reduce'
    } else if (isFollowupBuyCandidate && allReady && lowerConfirmed && strongBull && riskReady) {
      state = 'buy'
    } else if (isFollowupBuyCandidate && structureReady && lowerMissingAllowed && strongBull && riskReady) {
      state = 'probe'
    }
  }

  let reason: string
  if (inputState === 'blocked') {
    reason = '当前周期数据或结构输入不足，暂不生成可复核的行动结论。'
  } else if (inputState === 'provisional') {
    reason = '当前行情为未闭合或过期快照，先等待数据确认后再更新行动状态。'
  } else if (state === 'sell' && signal) {
    reason = `${PERIOD_LABELS[input.period]} ${structure.trendLabel}且${shortSignalLabel(signal)}成立，技术维度同步偏弱，卖侧确认门已满足。`
  } else if (state === 'reduce' && signal) {
    reason = `${PERIOD_LABELS[input.period]} ${structure.trendLabel}且${shortSignalLabel(signal)}成立，技术分 ${technical.score ?? '—'}；低级别确认缺失，因此不升级为卖出。`
  } else if (state === 'buy' && signal) {
    reason = `${PERIOD_LABELS[input.period]} ${shortSignalLabel(signal)}、技术维度和结构空间均达到确认门，当前可进入买侧确认状态。`
  } else if (state === 'probe' && signal) {
    reason = `${PERIOD_LABELS[input.period]} ${shortSignalLabel(signal)}成立，技术维度和结构空间较好；低级别确认缺失，暂按试仓观察。`
  } else if (conflicts.length > 0) {
    reason = '技术、结构或波浪方向存在分歧，暂不升级行动状态。'
  } else if (signal?.status === 'waiting_pullback') {
    reason = `${PERIOD_LABELS[input.period]} ${shortSignalLabel(signal)}仍在等待回抽确认，当前不追随未完成结构。`
  } else if (latest && (latest.signal.status === 'invalidated' || latest.signal.status === 'rejected')) {
    reason = `最近${shortSignalLabel(latest.signal)}已${latest.signal.status === 'invalidated' ? '失效' : '不成立'}，等待新的可复核结构。`
  } else {
    reason = `${PERIOD_LABELS[input.period]} 当前没有满足行动升级门槛的有效候选，继续等待结构和技术共振。`
  }

  const conditionsByContext = buildDecisionConditions(technical, active, latest, conditions, risk, support)
  let flatAction: StockSummaryDecision['flatAction']
  let holdingAction: StockSummaryDecision['holdingAction']
  if (inputState === 'blocked') {
    flatAction = '等待'
    holdingAction = '持有观察'
  } else if (inputState === 'provisional') {
    flatAction = '等待'
    holdingAction = '持有观察'
  } else {
    flatAction = state === 'buy' ? '买入' : state === 'probe' ? '试仓' : state === 'reduce' || state === 'sell' ? '暂不介入' : '等待'
    holdingAction = state === 'buy' ? '持有' : state === 'sell' ? '卖出' : state === 'reduce' ? '减仓' : '持有观察'
  }
  return {
    state,
    flatAction,
    holdingAction,
    inputState,
    reason,
    ...conditionsByContext,
  }
}

function buildLimitations(input: StockSummaryInput, quality: StockSummaryQualityInfo): string[] {
  const limitations = [...quality.reasons]
  if (input.chanlun.definitionMode === 'structure_proxy') limitations.push(input.chanlun.approximationLoss)
  limitations.push(...input.elliott.approximationLoss.slice(0, 1))
  if (input.elliott.ambiguity === 'multiple_viable') limitations.push('波浪本地代理存在多个可行计数，仅作分歧参考。')
  if (input.dataStatus?.amount_estimated) limitations.push('成交额为估算值，量价结论需谨慎解释。')
  return [...new Set(limitations.filter(Boolean))]
}

/**
 * 聚合详情页已经计算好的结果，生成可重复的确定性摘要。
 * 该函数不请求数据、不写持久化，也不会把代理结构升级成严格买卖点。
 */
export function buildStockSummary(input: StockSummaryInput): StockSummarySnapshot {
  const row = latestRow(input.rows, input.selectedBarKey, input.period)
  const score = scoreForSelection(input.technicalScores, input.rows, input.selectedBarKey, input.period)
  const quality = buildQuality(input, row, score)
  const technical = buildTechnical(score)
  const active = activeSignal(input.signalRiskContexts, input.preferredSignal)
  const latest = latestSignalContext(input.signalRiskContexts)
  const structure = buildStructure(input.chanlun, active)
  const conflicts = buildConflicts(technical, structure, input.elliott)
  const observation = buildObservation(quality, conflicts, active, latest)
  const support = nearestZone(input.priceZones, 'support')
  const resistance = nearestZone(input.priceZones, 'resistance')
  const current = nearestZone(input.priceZones, 'current')
  const riskContext = active
    ? input.signalRiskContexts.find(context => context.signal.id === active.signal.id) ?? null
    : null
  const risk: StockSummarySnapshot['risk'] = riskContext
    ? {
        status: riskContext.status,
        referencePrice: riskContext.referencePrice,
        invalidation: riskContext.invalidation,
        target1: riskContext.target1,
        riskReward1: riskContext.riskReward1,
        reason: riskContext.reason,
      }
    : { status: 'unavailable', referencePrice: input.chanlun.currentPrice, invalidation: null, target1: null, riskReward1: null, reason: '当前没有可用的活动候选' }
  const evidence = buildEvidence(input, technical, structure, active, support, resistance, risk)
  const qualityPrefix = quality.status === 'limited' ? '数据部分可用；' : quality.status === 'blocked' ? '当前数据不足；' : ''
  const headline = `${technical.direction} · ${structure.stateLabel} · ${observation.label}`
  const volumeSummary = technical.volumePrice == null
    ? '量价尚未评估'
    : technical.volumePrice < 50 ? '量价配合不足' : '量价状态未显示明显拖累'
  const summary = quality.status === 'blocked'
    ? '当前周期数据不足，暂不生成可复核的综合结论。'
    : `${qualityPrefix}${structure.trendLabel}，${active ? `出现${shortSignalLabel(active.signal)}，但仍需满足候选条件` : '暂未形成有效结构候选'}；${volumeSummary}。`
  const conditions = buildConditions(active)
  const invalidation = active && active.signal.boundary > 0
    ? [{ id: `invalidation-${active.signal.id}`, label: '结构失效边界', state: 'waiting' as const, text: `若触及 ${active.signal.boundary.toFixed(3)}，${active.direction === 'buy' ? '买侧' : '卖侧'}候选需要重新评估。`, sourceId: active.signal.id }]
    : []
  const limitations = buildLimitations(input, quality)
  const decision = buildDecision(
    input,
    row,
    score,
    technical,
    structure,
    active,
    latest,
    conflicts,
    conditions,
    risk,
    support,
  )
  return {
    context: {
      symbol: input.symbol,
      name: input.name,
      assetType: input.assetType,
      period: input.period,
      asOf: input.chanlun.window.end,
      windowStart: input.chanlun.window.start,
      windowEnd: input.chanlun.window.end,
      bars: input.chanlun.window.bars,
      priceBasis: '前复权',
      historical: !!input.selectedBarKey && normalizeKey(input.selectedBarKey, input.period) !== normalizeKey(input.rows.at(-1)?.date, input.period),
      dataStatus: input.dataStatus,
    },
    quality,
    versions: {
      summary: 'stock-summary-v1',
      decision: 'stock-decision-v1',
      technical: input.technicalScores?.version ?? null,
      structure: input.chanlun.ruleVersion ?? null,
      levels: input.priceZones[0]?.ruleVersion ?? null,
      risk: riskContext ? 'signal-risk-v1' : null,
      wave: input.elliott.schema ?? null,
    },
    technical,
    structure,
    observation,
    decision,
    headline,
    summary,
    supportingEvidence: evidence.supporting.slice(0, 3),
    opposingEvidence: evidence.opposing.slice(0, 3),
    conflicts,
    conditions,
    invalidation,
    levels: { support, resistance, current },
    risk,
    limitations,
    action: input.actionSignals ?? null,
    actionComparison: input.actionComparison ?? null,
  }
}

export function stockSummaryPeriodLabel(period: KlinePeriod): string {
  return PERIOD_LABELS[period]
}

export function stockSummaryScoreTone(value: number | null): StockSummaryTone {
  return scoreLabel(value).tone
}
