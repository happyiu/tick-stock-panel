import type { OHLC } from '@/components/EChartsCandlestick'

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
  ruleId: string
  family: ElliottCountFamily | string
  result: ElliottRuleResult
  evidence: string
  sourceLayer: 'modern_formalization' | 'engine_safety' | 'later_interpretation'
}

export interface ElliottEvidence {
  family: 'structure' | 'alternation' | 'proportionality' | 'fibonacci' | 'channel' | 'momentum' | 'volume' | 'multi_timeframe'
  result: ElliottEvidenceResult
  observation: string
  dependencyGroup: string
  weight?: string | number | null
}

export interface ElliottCount {
  label: string
  degree: string
  family: ElliottCountFamily
  direction: ElliottDirection
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
  assessmentId: string
  period: ElliottPeriod
  asOf: string | null
  availableAt: string | null
  priceBasis: '前复权' | '未知'
  definitionMode: 'swing_proxy' | 'untradable_unclear'
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
  label: string
  degree: string
  family: ElliottCountFamily
  direction: ElliottDirection
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
  definition_mode: 'swing_proxy' | 'structure_proxy' | 'untradable_unclear'
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
  bars: Array<Pick<OHLC, 'date' | 'open' | 'high' | 'low' | 'close' | 'volume'>>
  local_analysis: ElliottAnalysis
}

export interface ElliottCountDisplay {
  pattern: 'five_wave' | 'abc' | 'other' | 'none'
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

export function elliottFamilyLabel(family: ElliottCountFamily): string {
  return FAMILY_LABELS[family]
}

/** 把已有计数翻译成面板文案；不新增计数结论，也不把候选说成已确认。 */
export function describeElliottCount(count: ElliottCount | ElliottAssessmentCount | null): ElliottCountDisplay {
  if (!count) return { pattern: 'none', title: '暂无可用主计数', stage: '等待更多确认拐点', sequence: [] }

  const stage = count.stage?.trim()
  const hasABC = count.pivots.some(pivot => pivot.label === 'A')
    && count.pivots.some(pivot => pivot.label === 'B')
    && count.pivots.some(pivot => pivot.label === 'C')
  const fiveWave = count.family === 'impulse'
    || count.family === 'leading_diagonal'
    || count.family === 'ending_diagonal'
  if (fiveWave) {
    return {
      pattern: 'five_wave',
      title: count.family === 'impulse' ? '五浪推动候选' : `${elliottFamilyLabel(count.family)}五浪候选`,
      stage: stage && stage !== '五浪端点已观察' ? stage : '第5浪端点已出现，等待反向拐点确认',
      sequence: ['起点', '1', '2', '3', '4', '5?'],
    }
  }

  const abc = count.family === 'zigzag' || count.family === 'flat' || (count.family === 'unknown' && hasABC)
  if (abc) {
    return {
      pattern: 'abc',
      title: count.family === 'unknown' ? 'ABC修正候选（具体类型未确定）' : `${elliottFamilyLabel(count.family)}候选`,
      stage: stage && stage !== '三段修正端点候选' ? stage : 'C浪端点已出现，等待后续反向结构确认',
      sequence: ['起点', 'A', 'B', 'C?'],
    }
  }

  return {
    pattern: 'other',
    title: `${elliottFamilyLabel(count.family)}候选`,
    stage: stage || '结构候选，等待更多确认',
    sequence: count.pivots.map(pivot => pivot.label),
  }
}

interface Candidate {
  count: ElliottCount
  rules: ElliottRuleCheck[]
  evidence: ElliottEvidence[]
  fib: ElliottEvidence[]
  volume: ElliottEvidence[]
  rank: [number, number, number, number]
}

const PERIOD_FLOOR: Record<ElliottPeriod, number> = {
  '30m': 0.008,
  '1d': 0.02,
  '1w': 0.04,
  '1mo': 0.06,
}

const APPROXIMATION_LOSS = [
  '本地结果是确定性的摆动代理，不是严格艾略特计数',
  '只检查端点级普通推动浪规则，无法验证内部子浪和级别递归',
  '未自动加载高低级别周期，跨周期证据暂不可用',
]

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

function isFractalHigh(bars: OHLC[], index: number): boolean {
  const value = bars[index].high
  const left = bars.slice(index - 2, index).map(bar => bar.high)
  const right = bars.slice(index + 1, index + 3).map(bar => bar.high)
  return left.length === 2 && right.length === 2 && value >= Math.max(...left, ...right)
    && value > Math.min(...left, ...right)
}

function isFractalLow(bars: OHLC[], index: number): boolean {
  const value = bars[index].low
  const left = bars.slice(index - 2, index).map(bar => bar.low)
  const right = bars.slice(index + 1, index + 3).map(bar => bar.low)
  return left.length === 2 && right.length === 2 && value <= Math.min(...left, ...right)
    && value < Math.max(...left, ...right)
}

function pivotFromBar(
  bars: OHLC[],
  index: number,
  type: ElliottPivotType,
): ElliottPivot {
  const confirmIndex = index + 2
  return {
    label: '?',
    type,
    index,
    eventTime: bars[index].date,
    confirmedAt: bars[confirmIndex]?.date ?? null,
    availableAt: bars[confirmIndex]?.date ?? null,
    price: type === 'high' ? bars[index].high : bars[index].low,
    state: 'observed',
  }
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
  const pivots: ElliottPivot[] = []
  for (let index = 2; index < bars.length - 2; index += 1) {
    if (isFractalHigh(bars, index)) appendPivot(pivots, pivotFromBar(bars, index, 'high'), bars, period)
    if (isFractalLow(bars, index)) appendPivot(pivots, pivotFromBar(bars, index, 'low'), bars, period)
  }
  return pivots.map((pivot, index) => ({ ...pivot, label: String(index) }))
}

function suspectedPivot(bars: OHLC[], pivots: ElliottPivot[], period: ElliottPeriod): ElliottPivot | null {
  const last = pivots.at(-1)
  if (!last || last.index >= bars.length - 1) return null
  const tail = bars.slice(last.index + 1)
  if (tail.length === 0) return null
  const type: ElliottPivotType = last.type === 'high' ? 'low' : 'high'
  const extreme = type === 'high'
    ? tail.reduce((best, bar, offset) => bar.high >= best.price ? { price: bar.high, index: last.index + 1 + offset, date: bar.date } : best, { price: -Infinity, index: last.index + 1, date: tail[0].date })
    : tail.reduce((best, bar, offset) => bar.low <= best.price ? { price: bar.low, index: last.index + 1 + offset, date: bar.date } : best, { price: Infinity, index: last.index + 1, date: tail[0].date })
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

function rule(
  ruleId: string,
  result: ElliottRuleResult,
  evidence: string,
): ElliottRuleCheck {
  return {
    ruleId,
    family: 'impulse',
    result,
    evidence,
    sourceLayer: 'modern_formalization',
  }
}

function impulseRules(pivots: ElliottPivot[], direction: 'up' | 'down'): ElliottRuleCheck[] {
  const [origin, wave1, wave2, wave3, wave4, wave5] = pivots
  const wave1Length = Math.abs(wave1.price - origin.price)
  const wave3Length = Math.abs(wave3.price - wave2.price)
  const wave5Length = Math.abs(wave5.price - wave4.price)
  const wave2Origin = direction === 'up' ? wave2.price > origin.price : wave2.price < origin.price
  const wave3NotShortest = wave3Length >= Math.min(wave1Length, wave5Length) * 0.99
  const wave4NoOverlap = direction === 'up'
    ? wave4.price > Math.max(origin.price, wave1.price)
    : wave4.price < Math.min(origin.price, wave1.price)
  return [
    rule('impulse.wave2_origin', wave2Origin ? 'pass' : 'fail', wave2Origin
      ? '二浪仍位于一浪起点之外'
      : '二浪越过了一浪起点'),
    rule('impulse.wave3_not_shortest', wave3NotShortest ? 'pass' : 'fail', wave3NotShortest
      ? '三浪长度不短于一浪和五浪中的最短者'
      : '三浪成为一、三、五浪中最短的一段'),
    rule('impulse.wave4_no_overlap', wave4NoOverlap ? 'pass' : 'fail', wave4NoOverlap
      ? '四浪未进入一浪价格区间'
      : '四浪进入了一浪价格区间'),
    rule('impulse.internal_structure', 'unknown', '仅有端点数据，无法验证内部子浪结构'),
  ]
}

function ratioEvidence(label: string, ratio: number): ElliottEvidence {
  const targets = [0.382, 0.5, 0.618, 0.786, 1, 1.618]
  const nearest = Math.min(...targets.map(target => Math.abs(ratio - target) / target))
  const supported = nearest <= 0.12
  return {
    family: 'fibonacci',
    result: supported ? 'supports' : 'neutral',
    observation: `${label}比例 ${ratio.toFixed(3)}，固定参考集合${supported ? '存在接近关系' : '未形成明显关系'}`,
    dependencyGroup: 'price-pivots',
    weight: 'low',
  }
}

function countFromPivots(
  pivots: ElliottPivot[],
  family: ElliottCountFamily,
  direction: ElliottDirection,
  stage: string,
): ElliottCount {
  return {
    label: family === 'impulse' ? 'P1' : 'C1',
    degree: '当前周期相对级别',
    family,
    direction,
    stage,
    pivots,
    supportSummary: [],
    confirmation: [],
    invalidation: [],
    recountConditions: [],
    nextObservation: [],
  }
}

function impulseCandidate(bars: OHLC[], pivots: ElliottPivot[]): Candidate | null {
  if (pivots.length !== 6 || pivots[0].type === pivots[1].type) return null
  const direction: 'up' | 'down' = pivots[1].type === 'high' ? 'up' : 'down'
  const alternating = pivots.every((pivot, index) => index === 0 || pivot.type !== pivots[index - 1].type)
  if (!alternating) return null
  const rules = impulseRules(pivots, direction)
  const failed = rules.some(item => item.result === 'fail')
  const [origin, wave1, wave2, wave3, wave4, wave5] = pivots
  const count = countFromPivots(pivots, 'impulse', direction, '五浪端点已观察')
  count.supportSummary = failed ? ['普通推动浪条件未全部满足，已降级为待重计数'] : ['端点形态与普通五浪推动候选相容']
  count.confirmation = ['等待末端反向分型确认当前推动段完成']
  count.invalidation = rules.filter(item => item.result === 'fail').map(item => item.evidence)
  count.recountConditions = ['若一浪与四浪持续重叠，应另行评估对角线候选']
  count.nextObservation = ['观察下一次反向拐点是否确认或破坏当前端点结构']
  const wave1Length = Math.abs(wave1.price - origin.price)
  const wave3Length = Math.abs(wave3.price - wave2.price)
  const wave4Length = Math.abs(wave4.price - wave3.price)
  const fib = [
    ratioEvidence('二浪相对一浪回撤', Math.abs(wave2.price - wave1.price) / Math.max(wave1Length, Number.EPSILON)),
    ratioEvidence('四浪相对三浪回撤', wave4Length / Math.max(wave3Length, Number.EPSILON)),
    ratioEvidence('五浪相对一浪长度', Math.abs(wave5.price - wave4.price) / Math.max(wave1Length, Number.EPSILON)),
  ]
  const volumeEvidence: ElliottEvidence[] = []
  const wave1Bars = bars.slice(origin.index, wave2.index + 1).map(bar => bar.volume).filter(finite)
  const wave3Bars = bars.slice(wave2.index, wave4.index + 1).map(bar => bar.volume).filter(finite)
  if (wave1Bars.length > 0 && wave3Bars.length > 0) {
    const first = wave1Bars.reduce((sum, value) => sum + value, 0) / wave1Bars.length
    const third = wave3Bars.reduce((sum, value) => sum + value, 0) / wave3Bars.length
    volumeEvidence.push({
      family: 'volume',
      result: third > first * 1.1 ? 'supports' : 'neutral',
      observation: `三浪区间平均成交量为一浪的 ${(third / Math.max(first, Number.EPSILON)).toFixed(2)} 倍`,
      dependencyGroup: 'wave-volume',
      weight: 'low',
    })
  } else {
    volumeEvidence.push({ family: 'volume', result: 'unavailable', observation: '成交量缺失，无法比较推动段参与度', dependencyGroup: 'missing-volume', weight: null })
  }
  return {
    count,
    rules,
    evidence: [{ family: 'structure', result: failed ? 'conflicts' : 'supports', observation: failed ? '普通推动浪条件存在冲突' : '六个交替端点组成普通推动候选', dependencyGroup: 'price-pivots' }],
    fib,
    volume: volumeEvidence,
    rank: [failed ? 0 : 2, 6, failed ? 0 : 1, pivots[pivots.length - 1]?.index ?? 0],
  }
}

function correctionCandidate(pivots: ElliottPivot[]): Candidate | null {
  if (pivots.length !== 4 || pivots[0].type === pivots[1].type) return null
  const alternating = pivots.every((pivot, index) => index === 0 || pivot.type !== pivots[index - 1].type)
  if (!alternating) return null
  const direction: ElliottDirection = pivots[1].type === 'high' ? 'down' : 'up'
  const labeled = pivots.map((pivot, index) => ({ ...pivot, label: index === 0 ? '0' : ['A', 'B', 'C'][index - 1] }))
  const count = countFromPivots(labeled, 'unknown', direction, '三段修正端点候选')
  count.supportSummary = ['存在三段交替摆动，但内部子浪不足以区分具体修正家族']
  count.confirmation = ['等待 C 段终点确认及后续反向结构']
  count.invalidation = ['若下一拐点继续延伸并形成五段推动，应重新计数']
  count.recountConditions = ['新增拐点改变 A-B-C 的交替关系时重新计数']
  count.nextObservation = ['观察 C 段结束后是否出现新的推动段']
  return {
    count,
    rules: [{ ruleId: 'correction.internal_structure', family: 'unknown', result: 'unknown', evidence: '端点不足以判定锯齿、平台、三角形或组合结构', sourceLayer: 'engine_safety' }],
    evidence: [{ family: 'structure', result: 'supports', observation: '四个交替端点可形成三段修正代理', dependencyGroup: 'price-pivots' }],
    fib: [],
    volume: [{ family: 'volume', result: 'unavailable', observation: '本地修正代理不将成交量当作形态确认', dependencyGroup: 'correction-proxy', weight: null }],
    rank: [1, 3, 1, pivots[pivots.length - 1]?.index ?? 0],
  }
}

function emptyAnalysis(period: ElliottPeriod, bars: OHLC[], status: ElliottAnalysis['status'], issue: string): ElliottAnalysis {
  const first = bars[0]?.date ?? null
  const last = bars.at(-1)?.date ?? null
  return {
    schema: 'elliott.assessment.app.v1',
    assessmentId: `local-${period}-${last ?? 'empty'}`,
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
    hardRuleChecks: [],
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
  if (pivots.length < 4) return {
    ...emptyAnalysis(period, bars, 'insufficient', '已确认拐点少于 4 个'),
    pivots,
    dataQuality: { status: 'limited', missing: [], limitations: ['已确认拐点少于 4 个，无法形成候选'] },
  }

  const candidates: Candidate[] = []
  const recent = pivots.slice(-12)
  for (let start = 0; start <= recent.length - 6; start += 1) {
    const candidate = impulseCandidate(bars, recent.slice(start, start + 6))
    if (candidate) candidates.push(candidate)
  }
  for (let start = 0; start <= recent.length - 4; start += 1) {
    const candidate = correctionCandidate(recent.slice(start, start + 4))
    if (candidate) candidates.push(candidate)
  }
  const viable = candidates.filter(candidate => !candidate.rules.some(ruleItem => ruleItem.result === 'fail'))
  viable.sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || b.rank[2] - a.rank[2] || b.rank[3] - a.rank[3])
  const primary = viable[0] ?? null
  const alternate = viable.find(candidate => candidate.count.family !== primary?.count.family || candidate.count.direction !== primary?.count.direction)
  const suspected = suspectedPivot(bars, pivots, period)
  const allPivots = suspected ? [...pivots, suspected] : pivots
  const primaryCount = primary?.count ?? null
  // 即使普通推动候选因条件失败而没有成为主计数，也保留它的失败规则，
  // 让面板能够明确展示“为什么被淘汰”，而不是被四拐点修正代理覆盖。
  const impulseCandidateForRules = candidates.find(candidate => candidate.count.family === 'impulse')
  const hardRuleChecks = primary?.count.family === 'impulse'
    ? primary.rules
    : impulseCandidateForRules?.rules ?? primary?.rules ?? []
  const guidelineEvidence = primary?.evidence ?? [{ family: 'structure', result: 'unavailable', observation: '没有通过推动浪条件检查的本地候选', dependencyGroup: 'price-pivots' }]
  const fibonacciRelationships = primary?.fib ?? []
  const momentumVolumeEvidence = primary?.volume ?? [{ family: 'volume', result: 'unavailable', observation: '没有可用的本地候选用于成交量比较', dependencyGroup: 'missing-candidate', weight: null }]
  const ambiguity: ElliottAnalysis['ambiguity'] = alternate ? 'multiple_viable' : primary ? 'none' : 'unresolved'
  return {
    schema: 'elliott.assessment.app.v1',
    assessmentId: `local-${period}-${bars.at(-1)?.date ?? 'empty'}-${pivots.length}`,
    period,
    asOf: bars.at(-1)?.date ?? null,
    availableAt: bars.at(-1)?.date ?? null,
    priceBasis: '前复权',
    definitionMode: 'swing_proxy',
    dataQuality: { status: 'sufficient', missing: [], limitations: APPROXIMATION_LOSS },
    status: 'ready',
    window: { start: bars[0].date, end: bars.at(-1)?.date ?? null, bars: bars.length },
    pivots: allPivots,
    primaryCount,
    alternateCounts: alternate ? [alternate.count] : [],
    hardRuleChecks,
    guidelineEvidence,
    fibonacciRelationships,
    channelChecks: [{ family: 'channel', result: 'unavailable', observation: '本地代理未建立可审计的波浪通道', dependencyGroup: 'local-proxy', weight: null }],
    momentumVolumeEvidence,
    ambiguity,
    approximationLoss: APPROXIMATION_LOSS,
    confirmation: primaryCount?.confirmation ?? ['等待更多确认拐点'],
    invalidation: primaryCount?.invalidation ?? ['当前没有通过推动浪条件检查的主计数'],
    recountConditions: primaryCount?.recountConditions ?? ['新增拐点改变交替结构时重新计数'],
    nextObservation: primaryCount?.nextObservation ?? ['等待新的确认拐点以区分推动和修正候选'],
    currentPrice: bars.at(-1)?.close ?? null,
  }
}

export function elliottPeriodLabel(period: ElliottPeriod): string {
  return ({ '30m': '30F', '1d': '日K', '1w': '周K', '1mo': '月K' })[period]
}

export function elliottSnapshotFingerprint(bars: OHLC[], asOf?: string | null): string {
  const rows = normalizedBars(bars, asOf).map(bar => [bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume ?? null].join(':'))
  let hash = 2166136261
  for (const char of rows.join('|')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `${rows.length}-${(hash >>> 0).toString(16)}`
}
