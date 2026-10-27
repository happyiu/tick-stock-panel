export type ChanlunDirection = 'up' | 'down'
export type ChanlunFractalType = 'top' | 'bottom'
export type ChanlunStructureSource = 'stroke' | 'segment'
export type ChanlunCenterState = 'oscillating' | 'extension' | 'newborn' | 'broken_up' | 'broken_down'
export type ChanlunSignalKind = 'third_buy' | 'third_sell'
export type ChanlunSignalStatus = 'waiting_pullback' | 'candidate' | 'invalidated' | 'rejected'
export type ChanlunTrendType = 'uptrend_proxy' | 'downtrend_proxy' | 'consolidation_proxy' | 'unclear'
export type ChanlunConditionState = 'met' | 'waiting' | 'failed' | 'unavailable'
export type ChanlunCandidateKind = 'first_buy' | 'second_buy' | 'third_buy' | 'first_sell' | 'second_sell' | 'third_sell'
export type ChanlunCandidateOrigin = 'trend_divergence' | 'consolidation_divergence' | 'third_structure'

export interface ChanlunBarInput {
  date: string
  open: number
  high: number
  low: number
  close: number
  periodEnd?: string | null
  isClosed?: boolean
  volume?: number | null
  amount?: number | null
  macdHist?: number | null
  macd_hist?: number | null
  ma20?: number | null
  ma60?: number | null
  atr14?: number | null
}

export interface ChanlunMergedBar {
  sourceStartIndex: number
  sourceEndIndex: number
  startDate: string
  endDate: string
  high: number
  low: number
  highDate: string
  lowDate: string
  highSourceIndex: number
  lowSourceIndex: number
  direction: ChanlunDirection | 'unknown'
  uncertain: boolean
  closed: boolean
  periodEnd: string
}

export interface ChanlunFractal {
  type: ChanlunFractalType
  mergedIndex: number
  sourceIndex: number
  date: string
  price: number
  confirmedAt: string
  confirmedSourceIndex: number
}

export interface ChanlunStroke {
  id: string
  index: number
  direction: ChanlunDirection
  start: ChanlunFractal
  end: ChanlunFractal
  startDate: string
  endDate: string
  startPrice: number
  endPrice: number
  low: number
  high: number
  mergedBars: number
  changePct: number | null
  confirmed: boolean
  confirmedAt: string | null
  observedAt?: string
}

export interface ChanlunCenter {
  id: string
  confirmed?: boolean
  startStrokeIndex: number
  endStrokeIndex: number
  startDate: string
  endDate: string
  formedAt: string
  zd: number
  zg: number
  dd: number
  gg: number
  componentCount: number
  state: ChanlunCenterState
  source: ChanlunStructureSource
}

export interface ChanlunSegment {
  id: string
  index: number
  direction: ChanlunDirection
  startStrokeIndex: number
  endStrokeIndex: number
  startDate: string
  endDate: string
  startPrice: number
  endPrice: number
  low: number
  high: number
  componentCount: number
  bars: number
  changePct: number | null
  confirmed: boolean
  confirmedAt: string | null
  observedAt?: string
  ruleSource?: 'project'
  rule?: string
  confirmation?: { hasGap: boolean; featureStrokeIndices: number[]; reverseFeatureStrokeIndices: number[]; lastStrokeIndex: number | null }
}

export interface ChanlunTrend {
  id: string
  direction: ChanlunDirection | 'none'
  centerIds: string[]
  startDate: string
  endDate: string
  availableDate: string
  current: boolean
  band: { date: string; lower: number; upper: number }[]
  ruleSource: 'project'
}

export interface ChanlunCenterExtension {
  id: string
  centerId: string
  startDate: string
  endDate: string
  availableDate: string
  zd: number
  zg: number
  latest: boolean
  ruleSource: 'project'
}

export interface ChanlunCondition {
  id: 'center' | 'leave' | 'pullback' | 'outside' | 'lower_level' | 'context' | 'divergence' | 'rebound'
  label: string
  state: ChanlunConditionState
  evidence: string
}

export interface ChanlunDivergence {
  id: string
  availableDate?: string
  kind: 'trend' | 'consolidation' | 'macd'
  direction: ChanlunDirection
  status: 'candidate' | 'invalidated' | 'not_found' | 'unavailable'
  source: ChanlunStructureSource
  movementAIndex?: number
  movementCIndex?: number
  a?: { startDate: string; endDate: string; changePct: number | null; bars: number; force: number | null; macdArea: number | null }
  c?: { startDate: string; endDate: string; changePct: number | null; bars: number; force: number | null; macdArea: number | null }
  evidence: string
  structureDate?: string
  price?: number
  observedAt?: string
  structureConfirmed?: boolean
  references?: { endDate: string; endPrice: number }[]
  ruleSource?: 'czsc'
  rule?: { function: string; params: Record<string, string | number> }
  rawSignal?: { key: string; value: string }
  invalidatedAt?: string | null
  invalidationReason?: string | null
}

export interface ChanlunCandidateSignal {
  id: string
  kind: ChanlunCandidateKind
  status: ChanlunSignalStatus
  source: ChanlunStructureSource
  rule?: { function: string; params: Record<string, string | number> }
  rawSignal?: { key: string; value: string }
  boundaryRuleSource?: string
  observedAt?: string
  variant?: string
  structureConfirmed?: boolean
  boundaryRule?: string
  invalidationReason?: string
  structureDate: string
  availableDate: string
  price: number
  boundary: number
  invalidatedAt: string | null
  relatedSignalId: string | null
  /** 一/二类候选来源；盘整背驰只作为观察依据，不等同严格一买/一卖。 */
  origin?: ChanlunCandidateOrigin
  conditions: ChanlunCondition[]
  nextWatch: string
}

export interface ChanlunThirdSignal {
  id: string
  centerId: string
  kind: ChanlunSignalKind
  status: ChanlunSignalStatus
  structureDate: string
  availableDate: string
  price: number
  boundary: number
  leaveStrokeIndex: number
  pullbackStrokeIndex: number | null
  invalidatedAt: string | null
  lowerLevelTrigger: 'missing'
}

export interface ChanlunInterpretation {
  version: 1
  ruleSource: 'project'
  asOf: string | null
  closedPrice: number | null
  phase: { key: 'forming' | 'oscillating' | 'leaving' | 'insufficient'; label: string; subtitle: string; description: string }
  centerOrdinal: number
  legs: { label: string; strokes: ChanlunStroke[] }[]
  facts: string[]
  observation: { title: string; conditions: { id: string; text: string; state: 'met' | 'waiting'; warning: boolean }[] }
  levels: { key: string; label: string; price: number }[]
}

export interface ChanlunProjection {
  version: 1
  ruleSource: 'project'
  status: 'ready' | 'insufficient'
  description: string
  anchor: { date: string; availableDate: string; price: number } | null
  center: ChanlunProjectionZone | null
  zones: ChanlunProjectionZone[]
  side: 'above' | 'below' | 'inside' | null
  branches: { id: number; label: string; target: 'upper' | 'lower' | 'middle'; condition: string; meaning: string; rule?: { function: string; params: Record<string, number | string> } }[]
}

export interface ChanlunProjectionZone {
  kind: 'current' | 'upper' | 'lower'
  label: string
  centerId: string
  zd: number
  zg: number
  formedAt: string
}

export interface ChanlunAnalysis {
  ruleVersion: 4
  period: '30m' | '1d' | '1w' | '1mo'
  source: ChanlunStructureSource
  definitionMode: 'engine_rules'
  engine?: { name: string; version?: string; runtime?: string; commit: string; config: Record<string, unknown> }
  capabilities?: { supportedSources: string[]; segments: boolean; divergences: boolean; recursiveConfirmation: boolean; signalRules: { function: string; params: Record<string, string | number> }[]; trends?: boolean; centerExtensions?: boolean; projection?: boolean; segmentRuleSource?: 'project'; divergenceRules?: { function: string; params: Record<string, string | number> }[] }
  approximationLoss: string
  status: 'ready' | 'insufficient' | 'invalid_data' | 'unsupported' | 'engine_unavailable'
  issues: string[]
  window: {
    start: string | null
    end: string | null
    bars: number
    mergedBars: number
  }
  bars: ChanlunBarInput[]
  mergedBars: ChanlunMergedBar[]
  fractals: ChanlunFractal[]
  strokes: ChanlunStroke[]
  segments: ChanlunSegment[]
  centers: ChanlunCenter[]
  strokeCenters: ChanlunCenter[]
  segmentCenters: ChanlunCenter[]
  trendType: ChanlunTrendType
  divergences: ChanlunDivergence[]
  trends?: ChanlunTrend[]
  projection?: ChanlunProjection | null
  centerExtensions?: ChanlunCenterExtension[]
  candidateSignals: ChanlunCandidateSignal[]
  thirdSignals: ChanlunThirdSignal[]
  latestFractal: ChanlunFractal | null
  latestConfirmedStroke: ChanlunStroke | null
  formingStroke: ChanlunStroke | null
  latestCenter: ChanlunCenter | null
  latestSignal: ChanlunThirdSignal | null
  currentPrice: number | null
  pricePosition: 'inside' | 'above' | 'below' | null
  interpretation?: ChanlunInterpretation | null
}

/** 加载/空态仅创建数据容器，结构计算统一由后端完成。 */
export function emptyChanlunAnalysis(
  period: ChanlunAnalysis['period'] = '1d',
  source: ChanlunStructureSource = 'stroke',
): ChanlunAnalysis {
  return {
    ruleVersion: 4, period, source, definitionMode: 'engine_rules',
    capabilities: { supportedSources: ['stroke'], segments: false, divergences: false, recursiveConfirmation: false, signalRules: [] },
    approximationLoss: 'CZSC官方辅助信号；单周期条件不等于次级别确认；趋势为本项目中枢位置近似',
    status: 'insufficient', issues: [],
    window: { start: null, end: null, bars: 0, mergedBars: 0 },
    bars: [], mergedBars: [], fractals: [], strokes: [], segments: [], centers: [],
    strokeCenters: [], segmentCenters: [], trendType: 'unclear', divergences: [], trends: [], centerExtensions: [],
    candidateSignals: [], thirdSignals: [], latestFractal: null, latestConfirmedStroke: null,
    formingStroke: null, latestCenter: null, latestSignal: null, currentPrice: null, pricePosition: null, interpretation: null,
  }
}
