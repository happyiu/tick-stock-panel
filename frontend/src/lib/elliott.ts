import type { OHLC } from '@/components/EChartsCandlestick'
import { detectChanlunFractals, mergeChanlunBars, type ChanlunBarInput } from './chanlun.ts'

export type ElliottPeriod = '30m' | '1d' | '1w' | '1mo'
export type ElliottPivotType = 'high' | 'low'
export type ElliottPivotState = 'observed' | 'suspected' | 'projected'
export type ElliottCountFamily =
  | 'impulse'
  | 'leading_diagonal'
  | 'ending_diagonal'
  | 'zigzag'
  | 'flat'
  | 'triangle'
  | 'combination'
  | 'unknown'
export type ElliottDirection = 'up' | 'down' | 'sideways' | 'mixed'
export type ElliottRuleResult = 'pass' | 'fail' | 'unknown' | 'not_applicable'
export type ElliottEvidenceResult = 'supports' | 'conflicts' | 'neutral' | 'unavailable'
export type ElliottDefinitionMode = 'strict_elliott' | 'structure_proxy' | 'untradable_unclear'

export interface ElliottUnresolvedFamily {
  family: Exclude<ElliottCountFamily, 'unknown'>
  reason: string
}

export interface ElliottPivot {
  label: string
  type: ElliottPivotType
  index: number
  eventTime: string
  confirmedAt: string | null
  availableAt: string | null
  price: number
  state: ElliottPivotState
}

export interface ElliottRuleCheck {
  id?: string
  candidateId?: string
  ruleId: string
  family: ElliottCountFamily | string
  result: ElliottRuleResult
  evidence: string
  sourceLayer: 'original' | 'modern_formalization' | 'engine_safety' | 'later_interpretation'
}

export interface ElliottEvidence {
  id?: string
  candidateId?: string
  family: 'structure' | 'alternation' | 'proportionality' | 'fibonacci' | 'channel' | 'momentum' | 'volume' | 'multi_timeframe'
  result: ElliottEvidenceResult
  observation: string
  dependencyGroup: string
  weight?: string | number | null
}

export interface ElliottCount {
  id?: string
  label: string
  degree: string
  family: ElliottCountFamily
  direction: ElliottDirection
  currentWave?: string | null
  stage: string
  pivots: ElliottPivot[]
  supportSummary: string[]
  confirmation: string[]
  invalidation: string[]
  recountConditions: string[]
  nextObservation: string[]
}

export interface ElliottAnalysis {
  schema: 'elliott.assessment.app.v1'
  ruleVersion: number
  sourceRefs: string[]
  unresolvedFamilies: ElliottUnresolvedFamily[]
  assessmentId: string
  period: ElliottPeriod
  asOf: string | null
  availableAt: string | null
  priceBasis: '前复权' | '未知'
  definitionMode: ElliottDefinitionMode
  dataQuality: {
    status: 'sufficient' | 'limited' | 'blocked'
    missing: string[]
    limitations: string[]
  }
  status: 'ready' | 'insufficient' | 'invalid_data'
  window: { start: string | null; end: string | null; bars: number }
  pivots: ElliottPivot[]
  primaryCount: ElliottCount | null
  alternateCounts: ElliottCount[]
  hardRuleChecks: ElliottRuleCheck[]
  guidelineEvidence: ElliottEvidence[]
  fibonacciRelationships: ElliottEvidence[]
  channelChecks: ElliottEvidence[]
  momentumVolumeEvidence: ElliottEvidence[]
  ambiguity: 'none' | 'multiple_viable' | 'unresolved'
  approximationLoss: string[]
  confirmation: string[]
  invalidation: string[]
  recountConditions: string[]
  nextObservation: string[]
  currentPrice: number | null
}

export interface ElliottAssessmentPivot {
  label: string
  event_time?: string | null
  confirmed_at?: string | null
  available_at?: string | null
  price?: number | null
  state: ElliottPivotState
}

export interface ElliottAssessmentCount {
  id?: string
  candidate_id?: string
  label: string
  degree: string
  family: ElliottCountFamily
  direction: ElliottDirection
  current_wave?: string | null
  stage: string
  pivots: ElliottAssessmentPivot[]
  support_summary: string[]
  confirmation: string[]
  invalidation: string[]
  recount_conditions: string[]
  next_observation: string[]
}

export interface ElliottAssessmentResponse {
  schema: 'elliott.assessment.public.v1' | string
  assessment_id: string
  instrument: string
  market?: string
  timeframe: string
  as_of: string
  available_at: string
  price_basis: string
  rule_version?: number
  source_refs?: string[]
  unresolved_families?: ElliottUnresolvedFamily[]
  // 旧 `/analyze` 接口仍可能返回 swing_proxy；详情页不再消费它的计数。
  definition_mode: ElliottDefinitionMode | 'swing_proxy'
  data_quality: {
    status: 'sufficient' | 'limited' | 'blocked'
    missing: string[]
    limitations: string[]
  }
  primary_count: ElliottAssessmentCount
  alternate_counts: ElliottAssessmentCount[]
  hard_rule_checks: ElliottRuleCheck[]
  guideline_evidence: ElliottEvidence[]
  fibonacci_relationships: ElliottEvidence[]
  channel_checks: ElliottEvidence[]
  momentum_volume_evidence: ElliottEvidence[]
  ambiguity: 'none' | 'multiple_viable' | 'unresolved'
  approximation_loss: string[]
  confirmation: string[]
  invalidation: string[]
  recount_conditions: string[]
  next_observation: string[]
  research_only: true
  broker_connection_enabled: false
  automatic_orders: false
  order_authorized: false
  status: 'DRAFT_REVIEW'
  ic_pass: false
  allowed_action: 'observe'
  suggested_shares: 0
}

export interface ElliottAssessmentRequest {
  symbol: string
  period: ElliottPeriod
  as_of: string
  price_basis: string
  bars: Array<Pick<OHLC, 'date' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'periodEnd' | 'isClosed'>>
  local_analysis: ElliottAnalysis
}

export interface ElliottExplanationResponse {
  schema: 'elliott.explanation.public.v1' | string
  explanation_id: string
  instrument: string
  timeframe: ElliottPeriod
  as_of: string
  summary: string
  evidence_refs: string[]
  disagreements: string[]
  limitations: string[]
  confirmation: string[]
  invalidation: string[]
  recount_conditions: string[]
  next_observation: string[]
  source_refs: string[]
  research_only: true
}

export interface ElliottCountDisplay {
  pattern: 'five_wave' | 'abc' | 'triangle' | 'combination' | 'other' | 'none'
  title: string
  stage: string
  sequence: string[]
}

const FAMILY_LABELS: Record<ElliottCountFamily, string> = {
  impulse: '普通推动浪',
  leading_diagonal: '引导楔形',
  ending_diagonal: '终结楔形',
  zigzag: '锯齿修正',
  flat: '平台修正',
  triangle: '三角形修正',
  combination: '组合修正',
  unknown: '未定形态',
}

const FAMILY_PREFIX: Record<ElliottCountFamily, string> = {
  impulse: 'I',
  leading_diagonal: 'LD',
  ending_diagonal: 'ED',
  zigzag: 'ZZ',
  flat: 'FL',
  triangle: 'TR',
  combination: 'COM',
  unknown: 'UN',
}

const FAMILY_ORDER: ElliottCountFamily[] = [
  'impulse',
  'leading_diagonal',
  'ending_diagonal',
  'zigzag',
  'flat',
  'triangle',
  'combination',
  'unknown',
]

const PERIOD_FLOOR: Record<ElliottPeriod, number> = {
  '30m': 0.008,
  '1d': 0.02,
  '1w': 0.04,
  '1mo': 0.06,
}

const RULE_VERSION = 2
const SOURCE_REFS = ['local:elliott/rules/v2', 'local:elliott/evidence/v2']
const FLAT_B_RETRACE_MIN = 0.9
const APPROXIMATION_LOSS = [
  '本地结果是可复现的确认拐点规则，不替代完整的内部子浪递归计数',
  '推动浪和对角线只验证端点级形态；无法从当前周期端点证明内部子浪',
  '三角形与组合结构需要内部拓扑，当前数据不足时保持 unresolved',
  '未自动加载高低级别周期，跨周期证据暂不可用',
]

export function elliottFamilyLabel(family: ElliottCountFamily): string {
  return FAMILY_LABELS[family]
}

function sequenceForCount(count: ElliottCount): string[] {
  if (count.family === 'impulse' || count.family === 'leading_diagonal' || count.family === 'ending_diagonal') {
    return ['起点', '1', '2', '3', '4', '5?'].slice(0, count.pivots.length)
  }
  if (count.family === 'zigzag' || count.family === 'flat' || count.family === 'unknown') {
    return ['起点', 'A', 'B', 'C?'].slice(0, count.pivots.length)
  }
  if (count.family === 'triangle') {
    return ['起点', 'A', 'B', 'C', 'D', 'E?'].slice(0, count.pivots.length)
  }
  if (count.family === 'combination') {
    return ['起点', 'W', 'X', 'Y?'].slice(0, count.pivots.length)
  }
  return count.pivots.map(pivot => pivot.label)
}

function assessmentSequence(count: ElliottAssessmentCount): string[] {
  return sequenceForCount({
    label: count.label,
    degree: count.degree,
    family: count.family,
    direction: count.direction,
    currentWave: count.current_wave,
    stage: count.stage,
    pivots: count.pivots.map((pivot, index) => ({
      label: pivot.label,
      type: index % 2 === 0 ? 'low' : 'high',
      index,
      eventTime: pivot.event_time ?? '',
      confirmedAt: pivot.confirmed_at ?? null,
      availableAt: pivot.available_at ?? null,
      price: pivot.price ?? 0,
      state: pivot.state,
    })),
    supportSummary: count.support_summary,
    confirmation: count.confirmation,
    invalidation: count.invalidation,
    recountConditions: count.recount_conditions,
    nextObservation: count.next_observation,
  })
}

function isLocalCount(count: ElliottCount | ElliottAssessmentCount): count is ElliottCount {
  return 'supportSummary' in count
}

/** 把已有计数翻译成面板文案；不新增计数结论，也不把候选说成已确认。 */
export function describeElliottCount(count: ElliottCount | ElliottAssessmentCount | null): ElliottCountDisplay {
  if (!count) return { pattern: 'none', title: '暂无可用主计数', stage: '等待更多确认拐点', sequence: [] }

  const stage = count.stage?.trim()
  const sequence = isLocalCount(count)
    ? sequenceForCount(count)
    : assessmentSequence(count)
  const family = count.family
  if (family === 'impulse' || family === 'leading_diagonal' || family === 'ending_diagonal') {
    return {
      pattern: 'five_wave',
      title: family === 'impulse' ? '五浪推动候选' : elliottFamilyLabel(family) + '五浪候选',
      stage: stage && !stage.endsWith('端点已观察') ? stage : '第5浪端点已出现，等待反向拐点确认',
      sequence,
    }
  }
  if (family === 'zigzag' || family === 'flat' || family === 'unknown') {
    return {
      pattern: 'abc',
      title: family === 'unknown' ? 'ABC修正候选（具体类型未确定）' : elliottFamilyLabel(family) + '候选',
      stage: stage && !stage.includes('修正端点') ? stage : 'C浪端点已出现，等待后续反向结构确认',
      sequence,
    }
  }
  if (family === 'triangle') {
    return {
      pattern: 'triangle',
      title: '三角形修正候选',
      stage: stage || '等待 E 浪和边界确认',
      sequence,
    }
  }
  if (family === 'combination') {
    return {
      pattern: 'combination',
      title: '组合修正候选',
      stage: stage || '等待 W-X-Y 结构确认',
      sequence,
    }
  }
  return {
    pattern: 'other',
    title: elliottFamilyLabel(family) + '候选',
    stage: stage || '结构候选，等待更多确认',
    sequence,
  }
}

interface Candidate {
  count: ElliottCount
  rules: ElliottRuleCheck[]
  evidence: ElliottEvidence[]
  fib: ElliottEvidence[]
  channel: ElliottEvidence[]
  momentumVolume: ElliottEvidence[]
  strict: boolean
  rank: [number, number, number, number]
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizedBars(input: OHLC[], asOf?: string | null): OHLC[] {
  const boundary = asOf || null
  return input
    .filter(bar => bar && typeof bar.date === 'string')
    .filter(bar => !boundary || bar.date <= boundary)
    .filter(bar => [bar.open, bar.high, bar.low, bar.close].every(finite))
    .filter(bar => bar.open > 0 && bar.close > 0 && bar.low > 0)
    .filter(bar => bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close))
    .filter(bar => bar.volume == null || (finite(bar.volume) && bar.volume >= 0))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function trueRange(bar: OHLC, previousClose: number | null): number {
  if (previousClose == null) return Math.max(0, bar.high - bar.low)
  return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose))
}

function atrPercentAt(bars: OHLC[], index: number, window = 14): number {
  const start = Math.max(0, index - window + 1)
  let total = 0
  let count = 0
  for (let i = start; i <= index; i += 1) {
    const close = bars[i].close
    if (!finite(close) || close <= 0) continue
    total += trueRange(bars[i], i > 0 ? bars[i - 1].close : null) / close
    count += 1
  }
  return count > 0 ? total / count : 0
}

function moveThreshold(bars: OHLC[], pivotIndex: number, period: ElliottPeriod): number {
  const atr = atrPercentAt(bars, pivotIndex)
  return Math.min(0.2, Math.max(PERIOD_FLOOR[period], atr * 1.25))
}

function appendPivot(pivots: ElliottPivot[], candidate: ElliottPivot, bars: OHLC[], period: ElliottPeriod): void {
  const last = pivots.at(-1)
  if (!last) {
    pivots.push(candidate)
    return
  }
  if (last.type === candidate.type) {
    const moreExtreme = candidate.type === 'high'
      ? candidate.price >= last.price
      : candidate.price <= last.price
    if (moreExtreme) pivots[pivots.length - 1] = candidate
    return
  }
  const move = Math.abs(candidate.price / last.price - 1)
  if (move >= moveThreshold(bars, candidate.index, period)) pivots.push(candidate)
}

function confirmedPivots(bars: OHLC[], period: ElliottPeriod): ElliottPivot[] {
  const structureBars: ChanlunBarInput[] = bars
    .filter(bar => bar.isClosed === true)
    .map(bar => ({
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      periodEnd: bar.periodEnd ?? bar.date,
      isClosed: true,
    }))
  if (structureBars.length < 5) return []

  const mergedBars = mergeChanlunBars(structureBars)
  const fractals = detectChanlunFractals(mergedBars)
  const indexByDate = new Map(bars.map((bar, index) => [bar.date, index]))
  const snapshotAsOf = bars.at(-1)?.date ?? null
  const pivots: ElliottPivot[] = []
  for (const fractal of fractals) {
    if (snapshotAsOf && fractal.confirmedAt > snapshotAsOf) continue
    const index = indexByDate.get(fractal.date)
    if (index == null) continue
    appendPivot(pivots, {
      label: '?',
      type: fractal.type === 'top' ? 'high' : 'low',
      index,
      eventTime: fractal.date,
      confirmedAt: fractal.confirmedAt,
      availableAt: fractal.confirmedAt,
      price: fractal.price,
      state: 'observed',
    }, bars, period)
  }
  return pivots.map((pivot, index) => ({ ...pivot, label: String(index) }))
}

function suspectedPivot(bars: OHLC[], pivots: ElliottPivot[], period: ElliottPeriod): ElliottPivot | null {
  if (!bars.some(bar => bar.isClosed !== true)) return null
  const last = pivots.at(-1)
  if (!last || last.index >= bars.length - 1) return null
  const tail = bars.slice(last.index + 1)
  if (tail.length === 0) return null
  const type: ElliottPivotType = last.type === 'high' ? 'low' : 'high'
  const extreme = type === 'high'
    ? tail.reduce((best, bar, offset) => bar.high >= best.price
      ? { price: bar.high, index: last.index + 1 + offset, date: bar.date }
      : best, { price: -Infinity, index: last.index + 1, date: tail[0].date })
    : tail.reduce((best, bar, offset) => bar.low <= best.price
      ? { price: bar.low, index: last.index + 1 + offset, date: bar.date }
      : best, { price: Infinity, index: last.index + 1, date: tail[0].date })
  if (!finite(extreme.price) || Math.abs(extreme.price / last.price - 1) < moveThreshold(bars, extreme.index, period)) return null
  return {
    label: '?',
    type,
    index: extreme.index,
    eventTime: extreme.date,
    confirmedAt: null,
    availableAt: null,
    price: extreme.price,
    state: 'suspected',
  }
}

function candidateId(family: ElliottCountFamily, direction: ElliottDirection, pivots: ElliottPivot[]): string {
  return family + ':' + direction + ':' + pivots.map(pivot => pivot.eventTime).join(',')
}

function labelPivots(pivots: ElliottPivot[], labels: string[]): ElliottPivot[] {
  return pivots.map((pivot, index) => ({ ...pivot, label: labels[index] ?? pivot.label }))
}

function countFromPivots(
  pivots: ElliottPivot[],
  family: ElliottCountFamily,
  direction: ElliottDirection,
  stage: string,
  labels: string[],
): ElliottCount {
  const id = candidateId(family, direction, pivots)
  const labeled = labelPivots(pivots, labels)
  return {
    id,
    label: FAMILY_PREFIX[family] + '-' + (pivots[0]?.index ?? 0),
    degree: '当前周期相对级别',
    family,
    direction,
    currentWave: labeled.at(-1)?.label ?? null,
    stage,
    pivots: labeled,
    supportSummary: [],
    confirmation: [],
    invalidation: [],
    recountConditions: [],
    nextObservation: [],
  }
}

function rule(
  candidate: ElliottCount,
  ruleId: string,
  result: ElliottRuleResult,
  evidence: string,
  sourceLayer: ElliottRuleCheck['sourceLayer'] = 'modern_formalization',
): ElliottRuleCheck {
  return {
    id: candidate.id + ':' + ruleId,
    candidateId: candidate.id,
    ruleId,
    family: candidate.family,
    result,
    evidence,
    sourceLayer,
  }
}

function evidence(
  candidate: ElliottCount,
  family: ElliottEvidence['family'],
  result: ElliottEvidenceResult,
  observation: string,
  dependencyGroup: string,
  weight: string | number | null = null,
  idSuffix: string = family,
): ElliottEvidence {
  return {
    id: candidate.id + ':' + idSuffix,
    candidateId: candidate.id,
    family,
    result,
    observation,
    dependencyGroup,
    weight,
  }
}

function impulseRules(candidate: ElliottCount, direction: 'up' | 'down'): ElliottRuleCheck[] {
  const [origin, wave1, wave2, wave3, wave4, wave5] = candidate.pivots
  const wave1Length = Math.abs(wave1.price - origin.price)
  const wave3Length = Math.abs(wave3.price - wave2.price)
  const wave5Length = Math.abs(wave5.price - wave4.price)
  const wave2Origin = direction === 'up' ? wave2.price > origin.price : wave2.price < origin.price
  const wave3NotShortest = wave3Length >= Math.min(wave1Length, wave5Length)
  const wave4NoOverlap = direction === 'up' ? wave4.price > wave1.price : wave4.price < wave1.price
  return [
    rule(candidate, 'impulse.wave2_origin', wave2Origin ? 'pass' : 'fail', wave2Origin
      ? '二浪仍位于一浪起点之外'
      : '二浪越过了一浪起点'),
    rule(candidate, 'impulse.wave3_not_shortest', wave3NotShortest ? 'pass' : 'fail', wave3NotShortest
      ? '三浪长度不短于一浪和五浪中的最短者'
      : '三浪成为一、三、五浪中最短的一段'),
    rule(candidate, 'impulse.wave4_no_overlap', wave4NoOverlap ? 'pass' : 'fail', wave4NoOverlap
      ? '四浪未进入一浪价格区间'
      : '四浪进入了一浪价格区间'),
  ]
}

function diagonalRules(candidate: ElliottCount, direction: 'up' | 'down'): ElliottRuleCheck[] {
  const [origin, wave1, wave2, wave3, wave4, wave5] = candidate.pivots
  const wave1Length = Math.abs(wave1.price - origin.price)
  const wave3Length = Math.abs(wave3.price - wave2.price)
  const wave5Length = Math.abs(wave5.price - wave4.price)
  const wave2Origin = direction === 'up' ? wave2.price > origin.price : wave2.price < origin.price
  const wave3NotShortest = wave3Length >= Math.min(wave1Length, wave5Length)
  const overlap = direction === 'up'
    ? wave4.price > origin.price && wave4.price <= wave1.price
    : wave4.price < origin.price && wave4.price >= wave1.price
  const wave2Retrace = Math.abs(wave2.price - wave1.price) / Math.max(wave1Length, Number.EPSILON)
  const wave4Retrace = Math.abs(wave4.price - wave3.price) / Math.max(wave3Length, Number.EPSILON)
  const alternation = Math.abs(wave2Retrace - wave4Retrace) >= 0.05
  const progression = candidate.family === 'leading_diagonal'
    ? direction === 'up' ? wave5.price > wave3.price : wave5.price < wave3.price
    : direction === 'up' ? wave5.price <= wave3.price && wave5.price > wave1.price : wave5.price >= wave3.price && wave5.price < wave1.price
  return [
    rule(candidate, 'diagonal.wave2_origin', wave2Origin ? 'pass' : 'fail', wave2Origin
      ? '二浪仍位于一浪起点之外'
      : '二浪越过了一浪起点'),
    rule(candidate, 'diagonal.wave3_not_shortest', wave3NotShortest ? 'pass' : 'fail', wave3NotShortest
      ? '三浪长度不短于一浪和五浪中的最短者'
      : '三浪成为一、三、五浪中最短的一段'),
    rule(candidate, 'diagonal.wave4_overlap', overlap ? 'pass' : 'fail', overlap
      ? '四浪与一浪价格区间重叠，符合对角线例外'
      : '四浪没有形成对角线所需的重叠'),
    rule(candidate, 'diagonal.progression', progression ? 'pass' : 'unknown', progression
      ? candidate.family === 'leading_diagonal' ? '五浪继续推进，符合引导楔形端点关系' : '五浪未有效超过三浪，符合终结楔形端点关系'
      : '仅凭端点无法确认该对角线家族的推进关系'),
    rule(candidate, 'diagonal.alternation', alternation ? 'pass' : 'unknown', alternation
      ? '二浪和四浪回撤幅度存在交替'
      : '二浪和四浪回撤幅度过于接近，交替性不足', 'later_interpretation'),
  ]
}

function ratioEvidence(candidate: ElliottCount, label: string, ratio: number): ElliottEvidence {
  const targets = [0.382, 0.5, 0.618, 0.786, 1, 1.618]
  const nearest = Math.min(...targets.map(target => Math.abs(ratio - target) / target))
  const supported = nearest <= 0.12
  return evidence(
    candidate,
    'fibonacci',
    supported ? 'supports' : 'neutral',
    label + '比例 ' + ratio.toFixed(3) + '，固定参考集合' + (supported ? '存在接近关系' : '未形成明显关系'),
    'price-pivots',
    'low',
    'fib-' + label,
  )
}

function volumeEvidence(bars: OHLC[], candidate: ElliottCount): ElliottEvidence {
  if (candidate.pivots.length < 4) {
    return evidence(candidate, 'volume', 'unavailable', '确认拐点不足，无法比较成交量', 'missing-volume')
  }
  const first = candidate.pivots[0]
  const middle = candidate.pivots[Math.min(2, candidate.pivots.length - 1)]
  const firstValues = bars.slice(first.index, middle.index + 1).map(bar => bar.volume).filter(finite)
  const last = candidate.pivots.at(-1)!
  const lastValues = bars.slice(middle.index, last.index + 1).map(bar => bar.volume).filter(finite)
  if (firstValues.length === 0 || lastValues.length === 0) {
    return evidence(candidate, 'volume', 'unavailable', '成交量缺失，无法比较结构区间参与度', 'missing-volume')
  }
  const firstAverage = firstValues.reduce((sum, value) => sum + value, 0) / firstValues.length
  const lastAverage = lastValues.reduce((sum, value) => sum + value, 0) / lastValues.length
  const ratio = lastAverage / Math.max(firstAverage, Number.EPSILON)
  return evidence(
    candidate,
    'volume',
    ratio >= 1.1 ? 'supports' : 'neutral',
    '后段区间平均成交量为前段的 ' + ratio.toFixed(2) + ' 倍',
    'candidate-volume',
    'low',
  )
}

function momentumEvidence(bars: OHLC[], candidate: ElliottCount): ElliottEvidence {
  const values = bars
    .slice(candidate.pivots[0]?.index ?? 0, (candidate.pivots.at(-1)?.index ?? 0) + 1)
    .map(bar => bar.macd_hist)
    .filter(finite)
  if (values.length === 0) {
    return evidence(candidate, 'momentum', 'unavailable', '没有 MACD 柱体数据，无法比较动量', 'missing-momentum')
  }
  const latest = values.at(-1)!
  const direction = candidate.direction === 'up' ? 1 : candidate.direction === 'down' ? -1 : 0
  const aligned = direction === 0 || latest === 0 || Math.sign(latest) === direction
  return evidence(
    candidate,
    'momentum',
    aligned ? 'supports' : 'conflicts',
    '末端 MACD 柱体' + (aligned ? '与候选方向相容' : '与候选方向背离'),
    'candidate-momentum',
    'low',
  )
}

function channelEvidence(candidate: ElliottCount): ElliottEvidence[] {
  if (candidate.pivots.length < 4 || candidate.pivots.some(pivot => pivot.state !== 'observed')) {
    return [evidence(candidate, 'channel', 'unavailable', '确认拐点不足，无法建立可审计的波浪通道', 'missing-pivots')]
  }
  return [evidence(candidate, 'channel', 'neutral', '已确认端点可用于观察通道边界，但通道不作为硬规则', 'confirmed-pivots', 'low')]
}

function commonCandidateEvidence(bars: OHLC[], candidate: ElliottCount, structuralObservation: string, structuralResult: ElliottEvidenceResult): {
  evidence: ElliottEvidence[]
  fib: ElliottEvidence[]
  channel: ElliottEvidence[]
  momentumVolume: ElliottEvidence[]
} {
  const [origin, wave1, wave2, wave3, wave4, wave5] = candidate.pivots
  const guideline = [
    evidence(candidate, 'structure', structuralResult, structuralObservation, 'price-pivots'),
    evidence(candidate, 'alternation', 'supports', '确认拐点按高低点交替排列', 'price-pivots'),
    evidence(candidate, 'proportionality', 'neutral', '比例只作辅助观察，不单独确认形态', 'price-pivots', 'low'),
  ]
  const fib: ElliottEvidence[] = []
  if (candidate.pivots.length === 6 && wave1 && wave2 && wave3 && wave4 && wave5) {
    const wave1Length = Math.abs(wave1.price - origin.price)
    const wave3Length = Math.abs(wave3.price - wave2.price)
    fib.push(
      ratioEvidence(candidate, '二浪相对一浪回撤', Math.abs(wave2.price - wave1.price) / Math.max(wave1Length, Number.EPSILON)),
      ratioEvidence(candidate, '四浪相对三浪回撤', Math.abs(wave4.price - wave3.price) / Math.max(wave3Length, Number.EPSILON)),
      ratioEvidence(candidate, '五浪相对一浪长度', Math.abs(wave5.price - wave4.price) / Math.max(wave1Length, Number.EPSILON)),
    )
  } else if (candidate.pivots.length >= 4 && wave1 && wave2 && wave3) {
    fib.push(ratioEvidence(candidate, 'B 段相对 A 段回撤', Math.abs(wave2.price - wave1.price) / Math.max(Math.abs(wave1.price - origin.price), Number.EPSILON)))
  }
  const momentum = momentumEvidence(bars, candidate)
  return {
    evidence: guideline,
    fib,
    channel: channelEvidence(candidate),
    momentumVolume: [momentum, volumeEvidence(bars, candidate)],
  }
}

function evidenceSupportCount(grouped: Pick<Candidate, 'evidence' | 'fib' | 'channel' | 'momentumVolume'>): number {
  return [grouped.evidence, grouped.fib, grouped.channel, grouped.momentumVolume]
    .flat()
    .filter(item => item.result === 'supports').length
}

function impulseCandidate(bars: OHLC[], pivots: ElliottPivot[]): Candidate | null {
  if (pivots.length !== 6 || pivots[0].type === pivots[1].type) return null
  const direction: 'up' | 'down' = pivots[1].type === 'high' ? 'up' : 'down'
  if (!pivots.every((pivot, index) => index === 0 || pivot.type !== pivots[index - 1].type)) return null
  const count = countFromPivots(pivots, 'impulse', direction, '五浪端点已观察', ['0', '1', '2', '3', '4', '5'])
  const rules = impulseRules(count, direction)
  const failed = rules.some(item => item.result === 'fail')
  const grouped = commonCandidateEvidence(bars, count, failed ? '普通推动浪端点存在硬规则冲突' : '六个交替端点组成普通推动候选', failed ? 'conflicts' : 'supports')
  count.supportSummary = failed ? ['普通推动浪硬规则未全部满足，候选已淘汰'] : ['端点形态与普通五浪推动候选相容']
  count.confirmation = ['等待末端反向分型确认当前推动段完成']
  count.invalidation = rules.filter(item => item.result === 'fail').map(item => item.evidence)
  count.recountConditions = ['若一浪与四浪持续重叠，应重新评估对角线候选']
  count.nextObservation = ['观察下一次反向拐点是否确认或破坏当前端点结构']
  const strict = !rules.some(item => item.result === 'fail' || item.result === 'unknown')
  return {
    count,
    rules,
    ...grouped,
    strict,
    rank: [strict ? 2 : 1, pivots.length, evidenceSupportCount(grouped), pivots.at(-1)?.index ?? 0],
  }
}

function diagonalCandidate(bars: OHLC[], pivots: ElliottPivot[], family: 'leading_diagonal' | 'ending_diagonal'): Candidate | null {
  if (pivots.length !== 6 || pivots[0].type === pivots[1].type) return null
  if (!pivots.every((pivot, index) => index === 0 || pivot.type !== pivots[index - 1].type)) return null
  const direction: 'up' | 'down' = pivots[1].type === 'high' ? 'up' : 'down'
  const [origin, wave1, , wave3, wave4, wave5] = pivots
  const overlap = direction === 'up'
    ? wave4.price > origin.price && wave4.price <= wave1.price
    : wave4.price < origin.price && wave4.price >= wave1.price
  if (!overlap) return null
  const progressing = family === 'leading_diagonal'
    ? direction === 'up' ? wave5.price > wave3.price : wave5.price < wave3.price
    : direction === 'up' ? wave5.price <= wave3.price && wave5.price > wave1.price : wave5.price >= wave3.price && wave5.price < wave1.price
  if (!progressing) return null
  const count = countFromPivots(pivots, family, direction, '五浪对角线端点已观察', ['0', '1', '2', '3', '4', '5'])
  const rules = diagonalRules(count, direction)
  const grouped = commonCandidateEvidence(bars, count, family === 'leading_diagonal' ? '五段端点推进且四浪与一浪重叠，符合引导楔形候选' : '五段端点收敛且四浪与一浪重叠，符合终结楔形候选', 'supports')
  count.supportSummary = [family === 'leading_diagonal' ? '五浪继续推进并允许重叠，保留引导楔形候选' : '五浪未有效延伸并允许重叠，保留终结楔形候选']
  count.confirmation = ['等待末端反向分型确认对角线结束']
  count.invalidation = rules.filter(item => item.result === 'fail').map(item => item.evidence)
  count.recountConditions = ['若四浪不再重叠或五浪重新强势延伸，应重新评估推动浪/其他家族']
  count.nextObservation = ['观察五浪端点后的反向结构是否确认对角线完成']
  const strict = !rules.some(item => item.result === 'fail' || item.result === 'unknown')
  return {
    count,
    rules,
    ...grouped,
    strict,
    rank: [strict ? 2 : 1, pivots.length, evidenceSupportCount(grouped), pivots.at(-1)?.index ?? 0],
  }
}

function correctionCandidate(bars: OHLC[], pivots: ElliottPivot[], family: 'zigzag' | 'flat'): Candidate | null {
  if (pivots.length !== 4 || pivots[0].type === pivots[1].type) return null
  if (!pivots.every((pivot, index) => index === 0 || pivot.type !== pivots[index - 1].type)) return null
  const aDirection = pivots[1].price >= pivots[0].price ? 'up' : 'down'
  const bRetrace = Math.abs(pivots[2].price - pivots[1].price) / Math.max(Math.abs(pivots[1].price - pivots[0].price), Number.EPSILON)
  const bBreaksOrigin = aDirection === 'up' ? pivots[2].price <= pivots[0].price : pivots[2].price >= pivots[0].price
  const cExtendsA = aDirection === 'up' ? pivots[3].price > pivots[1].price : pivots[3].price < pivots[1].price
  const isFlat = bRetrace >= FLAT_B_RETRACE_MIN
  if (!cExtendsA || (family === 'zigzag' ? isFlat || bBreaksOrigin : !isFlat)) return null
  const direction: ElliottDirection = pivots[3].type === 'high' ? 'up' : 'down'
  const count = countFromPivots(pivots, family, direction, '三段修正端点已观察', ['0', 'A', 'B', 'C'])
  const rules = family === 'zigzag'
    ? [
      rule(count, 'zigzag.b_not_origin', bBreaksOrigin ? 'fail' : 'pass', bBreaksOrigin ? 'B 段突破了 A 段起点' : 'B 段未突破 A 段起点'),
      rule(count, 'zigzag.c_extends_a', cExtendsA ? 'pass' : 'fail', cExtendsA ? 'C 段超过 A 段端点' : 'C 段尚未超过 A 段端点'),
    ]
    : [
      rule(count, 'flat.b_retrace', isFlat ? 'pass' : 'fail', 'B 段回撤 A 段 ' + bRetrace.toFixed(3) + '，达到平台修正参考阈值'),
      rule(count, 'flat.c_reaches_a', cExtendsA ? 'pass' : 'fail', cExtendsA ? 'C 段达到并超过 A 段端点' : 'C 段尚未达到 A 段端点'),
    ]
  const grouped = commonCandidateEvidence(bars, count, family === 'zigzag' ? 'B 段较浅且 C 段延伸，符合锯齿修正端点关系' : 'B 段深回撤且 C 段延伸，符合平台修正端点关系', 'supports')
  count.supportSummary = [family === 'zigzag' ? 'B 段未破 A 段起点且 C 段延伸' : 'B 段深回撤且 C 段延伸']
  count.confirmation = ['等待 C 段后的反向拐点确认修正完成']
  count.invalidation = rules.filter(item => item.result === 'fail').map(item => item.evidence)
  count.recountConditions = ['若新增拐点改变 A-B-C 的延伸关系，应重新区分修正家族']
  count.nextObservation = ['观察 C 段端点后的新方向是否持续']
  const strict = !rules.some(item => item.result === 'fail' || item.result === 'unknown')
  return {
    count,
    rules,
    ...grouped,
    strict,
    rank: [strict ? 2 : 1, pivots.length, evidenceSupportCount(grouped), pivots.at(-1)?.index ?? 0],
  }
}

function unresolvedCorrectionCandidate(bars: OHLC[], pivots: ElliottPivot[]): Candidate | null {
  if (pivots.length !== 4 || pivots[0].type === pivots[1].type) return null
  if (!pivots.every((pivot, index) => index === 0 || pivot.type !== pivots[index - 1].type)) return null
  const direction: ElliottDirection = pivots[3].type === 'high' ? 'up' : 'down'
  const count = countFromPivots(pivots, 'unknown', direction, '三段修正端点候选', ['0', 'A', 'B', 'C'])
  const rules = [
    rule(count, 'correction.internal_structure', 'unknown', '端点不足以判定锯齿、平台、三角形或组合结构', 'engine_safety'),
  ]
  const grouped = commonCandidateEvidence(bars, count, '存在三段交替摆动，但具体修正家族尚未解决', 'neutral')
  count.supportSummary = ['存在 ABC 端点代理，但具体家族未解决']
  count.confirmation = ['等待 C 段后的反向结构和更多内部端点']
  count.invalidation = ['若后续形成五段推动，应重新计数']
  count.recountConditions = ['新增拐点改变 A-B-C 关系时重新计数']
  count.nextObservation = ['观察 C 段结束后是否形成新的推动段']
  return {
    count,
    rules,
    ...grouped,
    strict: false,
    rank: [0, pivots.length, evidenceSupportCount(grouped), pivots.at(-1)?.index ?? 0],
  }
}

function multiTimeframeEvidence(candidateId: string): ElliottEvidence {
  return {
    id: candidateId + ':multi-timeframe',
    candidateId,
    family: 'multi_timeframe',
    result: 'unavailable',
    observation: '本版本只分析当前周期，多周期证据不可用',
    dependencyGroup: 'current-period-only',
    weight: null,
  }
}

function unresolvedFamilyRuleChecks(): ElliottRuleCheck[] {
  return [
    {
      id: 'unresolved:triangle:topology',
      candidateId: 'unresolved:triangle',
      ruleId: 'triangle.topology_complete',
      family: 'triangle',
      result: 'unknown',
      evidence: '当前快照不足以确认 A-B-C-D-E 的交替收敛拓扑',
      sourceLayer: 'engine_safety',
    },
    {
      id: 'unresolved:combination:internal-structure',
      candidateId: 'unresolved:combination',
      ruleId: 'combination.internal_structure',
      family: 'combination',
      result: 'unknown',
      evidence: '当前快照不足以确认 W-X-Y 的内部连接结构',
      sourceLayer: 'engine_safety',
    },
  ]
}

function emptyAnalysis(period: ElliottPeriod, bars: OHLC[], status: ElliottAnalysis['status'], issue: string): ElliottAnalysis {
  const first = bars[0]?.date ?? null
  const last = bars.at(-1)?.date ?? null
  return {
    schema: 'elliott.assessment.app.v1',
    ruleVersion: RULE_VERSION,
    sourceRefs: SOURCE_REFS,
    unresolvedFamilies: [
      { family: 'triangle', reason: '当前快照缺少足够内部拓扑，无法严格确认三角形' },
      { family: 'combination', reason: '当前快照缺少足够内部拓扑，无法严格确认组合结构' },
    ],
    assessmentId: 'local-' + period + '-' + (last ?? 'empty'),
    period,
    asOf: last,
    availableAt: last,
    priceBasis: '前复权',
    definitionMode: 'untradable_unclear',
    dataQuality: { status: status === 'invalid_data' ? 'blocked' : 'limited', missing: [], limitations: [issue] },
    status,
    window: { start: first, end: last, bars: bars.length },
    pivots: [],
    primaryCount: null,
    alternateCounts: [],
    hardRuleChecks: unresolvedFamilyRuleChecks(),
    guidelineEvidence: [],
    fibonacciRelationships: [],
    channelChecks: [],
    momentumVolumeEvidence: [],
    ambiguity: 'unresolved',
    approximationLoss: APPROXIMATION_LOSS,
    confirmation: [],
    invalidation: [],
    recountConditions: [],
    nextObservation: [issue],
    currentPrice: bars.at(-1)?.close ?? null,
  }
}

function uniqueById<T extends { id?: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const id = item.id
    if (!id) return true
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function compareCandidates(a: Candidate, b: Candidate): number {
  for (let index = 0; index < a.rank.length; index += 1) {
    if (a.rank[index] !== b.rank[index]) return b.rank[index] - a.rank[index]
  }
  return FAMILY_ORDER.indexOf(a.count.family) - FAMILY_ORDER.indexOf(b.count.family)
}

export function analyzeElliott(input: OHLC[], period: ElliottPeriod, asOf?: string | null): ElliottAnalysis {
  const boundary = asOf || null
  const scopedInput = input.filter(bar => bar && typeof bar.date === 'string' && (!boundary || bar.date <= boundary))
  const bars = normalizedBars(input, asOf)
  if (bars.length === 0) return emptyAnalysis(period, bars, 'invalid_data', '没有可用的有效 OHLC 数据')
  if (scopedInput.length > 0 && scopedInput.length - bars.length > scopedInput.length * 0.1) {
    return emptyAnalysis(period, bars, 'invalid_data', '无效行情超过样本的 10%')
  }
  if (bars.length < 20) return emptyAnalysis(period, bars, 'insufficient', '至少需要 20 根有效 K 线')

  const pivots = confirmedPivots(bars, period)
  if (pivots.length < 4) {
    return {
      ...emptyAnalysis(period, bars, 'insufficient', '已确认拐点少于 4 个'),
      pivots,
      dataQuality: {
        status: 'limited',
        missing: bars.some(bar => bar.isClosed !== true) ? ['未闭合 K 线'] : [],
        limitations: ['已确认拐点少于 4 个，无法形成候选'],
      },
    }
  }

  const candidates: Candidate[] = []
  const recent = pivots.slice(-12)
  for (let start = 0; start <= recent.length - 6; start += 1) {
    const window = recent.slice(start, start + 6)
    const impulse = impulseCandidate(bars, window)
    if (impulse) candidates.push(impulse)
    const leading = diagonalCandidate(bars, window, 'leading_diagonal')
    if (leading) candidates.push(leading)
    const ending = diagonalCandidate(bars, window, 'ending_diagonal')
    if (ending) candidates.push(ending)
  }
  for (let start = 0; start <= recent.length - 4; start += 1) {
    const window = recent.slice(start, start + 4)
    const zigzag = correctionCandidate(bars, window, 'zigzag')
    if (zigzag) candidates.push(zigzag)
    const flat = correctionCandidate(bars, window, 'flat')
    if (flat) candidates.push(flat)
    if (!zigzag && !flat) {
      const unresolved = unresolvedCorrectionCandidate(bars, window)
      if (unresolved) candidates.push(unresolved)
    }
  }

  const uniqueCandidates = [...new Map(candidates.map(candidate => [candidate.count.id, candidate])).values()]
  const viable = uniqueCandidates
    .filter(candidate => !candidate.rules.some(ruleItem => ruleItem.result === 'fail'))
    .sort(compareCandidates)
  const primary = viable[0] ?? null
  const primaryId = primary?.count.id
  const alternates = viable
    .filter(candidate => candidate.count.id !== primaryId)
    .slice(0, 2)
  const suspected = suspectedPivot(bars, pivots, period)
  const allPivots = suspected ? [...pivots, suspected] : pivots
  const unresolvedFamilies: ElliottUnresolvedFamily[] = [
    { family: 'triangle', reason: '当前周期端点不足以验证 A-B-C-D-E 的内部收敛拓扑' },
    { family: 'combination', reason: '当前周期端点不足以验证 W-X-Y 的内部连接结构' },
  ]
  const primaryCount = primary?.count ?? null
  const allRules = uniqueById([
    ...uniqueCandidates.flatMap(candidate => candidate.rules),
    ...unresolvedFamilyRuleChecks(),
  ])
  const selectedEvidence = primary ?? viable[0]
  const guidelineEvidence = selectedEvidence?.evidence ?? [{
    id: 'analysis:structure',
    candidateId: 'analysis',
    family: 'structure',
    result: 'unavailable',
    observation: '没有可用的本地候选用于结构证据',
    dependencyGroup: 'price-pivots',
    weight: null,
  }]
  const fibonacciRelationships = selectedEvidence?.fib ?? []
  const channelChecks = selectedEvidence?.channel ?? [{
    id: 'analysis:channel',
    candidateId: 'analysis',
    family: 'channel',
    result: 'unavailable',
    observation: '没有可用的本地候选用于建立波浪通道',
    dependencyGroup: 'missing-candidate',
    weight: null,
  }]
  const momentumVolumeEvidence = selectedEvidence?.momentumVolume ?? [{
    id: 'analysis:momentum-volume',
    candidateId: 'analysis',
    family: 'momentum',
    result: 'unavailable',
    observation: '没有可用的本地候选用于动量和成交量比较',
    dependencyGroup: 'missing-candidate',
    weight: null,
  }]
  momentumVolumeEvidence.push(multiTimeframeEvidence(selectedEvidence?.count.id ?? 'analysis'))
  const ambiguity: ElliottAnalysis['ambiguity'] = alternates.length > 0
    ? 'multiple_viable'
    : primary
      ? 'none'
      : 'unresolved'
  const lastBar = bars.at(-1)
  const availableAt = lastBar?.periodEnd && lastBar.periodEnd <= (lastBar.date ?? '')
    ? lastBar.periodEnd
    : lastBar?.date ?? null
  const limitations = [
    ...APPROXIMATION_LOSS,
    ...(bars.some(bar => bar.isClosed !== true) ? ['末根 K 线尚未闭合或闭合状态未知，仅参与形成中展示'] : []),
  ]
  return {
    schema: 'elliott.assessment.app.v1',
    ruleVersion: RULE_VERSION,
    sourceRefs: SOURCE_REFS,
    unresolvedFamilies,
    assessmentId: 'local-' + period + '-' + (bars.at(-1)?.date ?? 'empty') + '-' + pivots.length,
    period,
    asOf: bars.at(-1)?.date ?? null,
    availableAt,
    priceBasis: '前复权',
    definitionMode: primary?.strict ? 'strict_elliott' : 'structure_proxy',
    dataQuality: {
      status: 'sufficient',
      missing: bars.some(bar => bar.isClosed !== true) ? ['未闭合 K 线'] : [],
      limitations,
    },
    status: 'ready',
    window: { start: bars[0].date, end: bars.at(-1)?.date ?? null, bars: bars.length },
    pivots: allPivots,
    primaryCount,
    alternateCounts: alternates.map(candidate => candidate.count),
    hardRuleChecks: allRules,
    guidelineEvidence,
    fibonacciRelationships,
    channelChecks,
    momentumVolumeEvidence,
    ambiguity,
    approximationLoss: APPROXIMATION_LOSS,
    confirmation: primaryCount?.confirmation ?? ['等待更多确认拐点'],
    invalidation: primaryCount?.invalidation ?? ['当前没有通过硬规则的主计数'],
    recountConditions: primaryCount?.recountConditions ?? ['新增拐点改变交替结构时重新计数'],
    nextObservation: primaryCount?.nextObservation ?? ['等待新的确认拐点以区分推动和修正候选'],
    currentPrice: bars.at(-1)?.close ?? null,
  }
}

export function elliottPeriodLabel(period: ElliottPeriod): string {
  return ({ '30m': '30F', '1d': '日K', '1w': '周K', '1mo': '月K' })[period]
}

export function elliottSnapshotFingerprint(bars: OHLC[], asOf?: string | null): string {
  const rows = normalizedBars(bars, asOf).map(bar => [
    bar.date,
    bar.periodEnd ?? null,
    bar.isClosed ?? null,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume ?? null,
  ].join(':'))
  let hash = 2166136261
  for (const char of rows.join('|')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return rows.length + '-' + (hash >>> 0).toString(16)
}
