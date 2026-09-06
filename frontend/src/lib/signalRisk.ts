import type { ChanlunCandidateKind, ChanlunCandidateSignal } from '@/lib/chanlun'
import type { PriceZone } from '@/lib/priceZones'

export type SignalRiskStatus = 'calculable' | 'unavailable'

export interface SignalRiskContext {
  signal: ChanlunCandidateSignal
  direction: 'buy' | 'sell'
  referencePrice: number | null
  invalidation: number | null
  target1: PriceZone | null
  target2: PriceZone | null
  riskPct: number | null
  target1Pct: number | null
  target2Pct: number | null
  riskReward1: number | null
  riskReward2: number | null
  status: SignalRiskStatus
  reason?: string
}

function isBuy(kind: ChanlunCandidateKind): boolean {
  return kind.endsWith('_buy')
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  return numerator / denominator
}

function contextUnavailable(
  signal: ChanlunCandidateSignal,
  direction: 'buy' | 'sell',
  referencePrice: number | null,
  reason: string,
): SignalRiskContext {
  return {
    signal,
    direction,
    referencePrice,
    invalidation: finitePositive(signal.boundary) ? signal.boundary : null,
    target1: null,
    target2: null,
    riskPct: null,
    target1Pct: null,
    target2Pct: null,
    riskReward1: null,
    riskReward2: null,
    status: 'unavailable',
    reason,
  }
}

/**
 * 以观察时点价格计算结构空间。候选的 structureDate 只用于说明结构发生时间，
 * 不作为假定成交价；股票和 ETF 的卖侧仅展示下行观察空间，不表达做空收益。
 */
export function buildSignalRiskContext(
  signal: ChanlunCandidateSignal,
  zones: PriceZone[],
  referencePrice: number | null,
): SignalRiskContext {
  const direction = isBuy(signal.kind) ? 'buy' : 'sell'
  if (!finitePositive(referencePrice)) {
    return contextUnavailable(signal, direction, referencePrice, '观察时点价格不可用')
  }
  if (signal.status === 'invalidated' || signal.status === 'rejected') {
    return contextUnavailable(signal, direction, referencePrice, '候选已失效或不成立')
  }
  if (!finitePositive(signal.boundary)) {
    return contextUnavailable(signal, direction, referencePrice, '缺少结构失效边界')
  }

  const invalidation = signal.boundary
  const validDirection = direction === 'buy' ? invalidation < referencePrice : invalidation > referencePrice
  if (!validDirection) {
    return contextUnavailable(signal, direction, referencePrice, '失效边界与当前方向不一致')
  }

  const targets = zones
    .filter(zone => direction === 'buy' ? zone.side === 'resistance' : zone.side === 'support')
    .filter(zone => direction === 'buy' ? zone.low > referencePrice : zone.high < referencePrice)
    .sort((a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity))
  const target1 = targets[0] ?? null
  const target2 = targets[1] ?? null
  if (!target1) {
    return contextUnavailable(signal, direction, referencePrice, '当前方向没有可用的参考目标区间')
  }

  const riskDistance = direction === 'buy' ? referencePrice - invalidation : invalidation - referencePrice
  const target1Distance = direction === 'buy' ? target1.low - referencePrice : referencePrice - target1.high
  const target2Distance = target2
    ? direction === 'buy' ? target2.low - referencePrice : referencePrice - target2.high
    : null
  const riskPct = ratio(riskDistance, referencePrice)
  const target1Pct = ratio(target1Distance, referencePrice)
  const target2Pct = target2Distance == null ? null : ratio(target2Distance, referencePrice)
  if (riskPct == null || riskPct <= 0 || target1Pct == null || target1Pct <= 0) {
    return contextUnavailable(signal, direction, referencePrice, '风险或目标空间无法计算')
  }

  return {
    signal,
    direction,
    referencePrice,
    invalidation,
    target1,
    target2,
    riskPct,
    target1Pct,
    target2Pct,
    riskReward1: target1Pct / riskPct,
    riskReward2: target2Pct == null ? null : target2Pct / riskPct,
    status: 'calculable',
  }
}

export function buildSignalRiskContexts(
  signals: ChanlunCandidateSignal[],
  zones: PriceZone[],
  referencePrice: number | null,
): SignalRiskContext[] {
  return signals.map(signal => buildSignalRiskContext(signal, zones, referencePrice))
}

export function selectPreferredSignal(contexts: SignalRiskContext[]): SignalRiskContext | null {
  const active = contexts
    .filter(context => context.signal.status === 'candidate' || context.signal.status === 'waiting_pullback')
    .sort((a, b) => {
      const statusScore = (status: string) => status === 'candidate' ? 1 : 0
      const statusDiff = statusScore(b.signal.status) - statusScore(a.signal.status)
      if (statusDiff !== 0) return statusDiff
      return b.signal.availableDate.localeCompare(a.signal.availableDate)
    })
  return active[0] ?? contexts[0] ?? null
}
