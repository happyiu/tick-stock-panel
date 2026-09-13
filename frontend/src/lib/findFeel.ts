import type { KlinePeriod, KlineRow } from '@/lib/api'

export const FIND_FEEL_QUANTITY = 100

const QUANTITY_ERROR = '交易数量必须是 100 股的整数倍，且至少 100 股。'

function normalizeBarKey(value: unknown, period: KlinePeriod): string {
  const text = String(value ?? '')
  return period === '30m' ? text.replace('T', ' ').slice(0, 16) : text.slice(0, 10)
}

export type FindFeelAction = 'buy' | 'sell' | 'skip'
export type FindFeelStartMode = 'random' | 'selected'
export type FindFeelPhase = 'playing' | 'finished'

export interface FindFeelBar {
  key: string
  close: number
  open?: number
  high?: number
  low?: number
  isClosed?: boolean
}

export interface FindFeelMetricSnapshot {
  equity: number
  cash: number
  marketValue: number
  shares: number
  positionPct: number
  totalPnl: number
  totalReturn: number
  maxDrawdown: number
  currentPrice: number
  peakEquity: number
}

export interface FindFeelEquityPoint {
  step: number
  barKey: string
  equity: number
  action?: FindFeelAction
}

export interface FindFeelDecision {
  step: number
  barKey: string
  action: FindFeelAction
  price: number
  quantity: number
  executed: boolean
  reason?: string
  nextBarKey?: string
}

export interface FindFeelSession {
  initialCash: number
  targetSteps: number
  startBarKey: string
  currentBarKey: string
  currentIndex: number
  completedSteps: number
  phase: FindFeelPhase
  endReason?: 'target_steps' | 'no_next_bar'
  cash: number
  shares: number
  metrics: FindFeelMetricSnapshot
  history: FindFeelDecision[]
  equityCurve: FindFeelEquityPoint[]
}

export interface FindFeelStartOptions {
  mode: FindFeelStartMode
  period?: KlinePeriod
  selectedBarKey?: string | null
  random?: () => number
}

export interface FindFeelSessionOptions extends FindFeelStartOptions {
  initialCash: number
  targetSteps: number
  bars: FindFeelBar[]
}

export interface FindFeelActionAvailability {
  buy: boolean
  sell: boolean
  skip: boolean
  buyReason?: string
  sellReason?: string
}

export interface FindFeelActionResult {
  session: FindFeelSession
  accepted: boolean
  reason?: string
}

/** 将交易数量标准化为合法的整手数量；返回 0 表示输入不合法。 */
export function normalizeFindFeelQuantity(value: number): number {
  const quantity = Number(value)
  if (!Number.isInteger(quantity) || quantity < FIND_FEEL_QUANTITY || quantity % FIND_FEEL_QUANTITY !== 0) return 0
  return quantity
}

/** 从已加载的 K 线快照提取可用于玩法的、按原顺序去重的已收盘 K 线。 */
export function normalizeFindFeelBars(rows: KlineRow[], period: KlinePeriod): FindFeelBar[] {
  const seen = new Set<string>()
  const result: FindFeelBar[] = []
  for (const row of rows) {
    // API 会明确标记当前未收盘根；兼容旧缓存中缺少该字段的历史行。
    if (row.is_closed === false) continue
    const close = Number(row.close)
    const key = normalizeBarKey(row.date, period)
    if (!key || !Number.isFinite(close) || close <= 0 || seen.has(key)) continue
    seen.add(key)
    result.push({
      key,
      close,
      open: Number.isFinite(Number(row.open)) ? Number(row.open) : undefined,
      high: Number.isFinite(Number(row.high)) ? Number(row.high) : undefined,
      low: Number.isFinite(Number(row.low)) ? Number(row.low) : undefined,
      isClosed: row.is_closed,
    })
  }
  return result
}

/** 解析起点；随机模式优先选仍有下一根 K 线的位置。 */
export function resolveFindFeelStartIndex(
  bars: FindFeelBar[],
  options: FindFeelStartOptions,
): number | null {
  if (!bars.length) return null
  if (options.mode === 'selected') {
    const selected = options.selectedBarKey
      ? normalizeBarKey(options.selectedBarKey, options.period ?? '1d')
      : ''
    // 选中键在调用方通常已按周期归一化；再次归一化以兼容传入 ISO 时间。
    const exactIndex = options.selectedBarKey
      ? bars.findIndex(bar => bar.key === options.selectedBarKey || bar.key === selected)
      : -1
    return exactIndex >= 0 ? exactIndex : bars.length - 1
  }

  const random = options.random ?? Math.random
  const candidates = bars.length > 1 ? bars.slice(0, -1) : bars
  const sampled = Number(random())
  const ratio = Number.isFinite(sampled) ? Math.max(0, Math.min(0.999999999, sampled)) : 0
  return Math.min(candidates.length - 1, Math.floor(ratio * candidates.length))
}

function metricSnapshot(
  initialCash: number,
  cash: number,
  shares: number,
  currentPrice: number,
  peakEquity: number,
): FindFeelMetricSnapshot {
  const marketValue = shares * currentPrice
  const equity = cash + marketValue
  const nextPeak = Math.max(initialCash, peakEquity, equity)
  return {
    equity,
    cash,
    marketValue,
    shares,
    positionPct: equity > 0 ? marketValue / equity : 0,
    totalPnl: equity - initialCash,
    totalReturn: initialCash > 0 ? equity / initialCash - 1 : 0,
    maxDrawdown: nextPeak > 0 ? Math.max(0, (nextPeak - equity) / nextPeak) : 0,
    currentPrice,
    peakEquity: nextPeak,
  }
}

export function getFindFeelActionAvailability(
  session: FindFeelSession,
  quantity = FIND_FEEL_QUANTITY,
): FindFeelActionAvailability {
  if (session.phase === 'finished') {
    return {
      buy: false,
      sell: false,
      skip: false,
      buyReason: '本局已结束',
      sellReason: '本局已结束',
    }
  }
  const selectedQuantity = normalizeFindFeelQuantity(quantity)
  const buyMaxQuantity = getFindFeelMaxQuantity(session, 'buy')
  const sellMaxQuantity = getFindFeelMaxQuantity(session, 'sell')
  const validQuantity = selectedQuantity > 0
  const buy = validQuantity && selectedQuantity <= buyMaxQuantity
  const sell = validQuantity && selectedQuantity <= sellMaxQuantity
  return {
    buy,
    sell,
    skip: true,
    buyReason: buy
      ? undefined
      : !validQuantity
        ? QUANTITY_ERROR
        : buyMaxQuantity > 0
          ? `现金不足，最多可买 ${buyMaxQuantity.toLocaleString()} 股`
          : '现金不足',
    sellReason: sell
      ? undefined
      : !validQuantity
        ? QUANTITY_ERROR
        : sellMaxQuantity > 0
          ? `持仓不足，最多可卖 ${sellMaxQuantity.toLocaleString()} 股`
          : '持仓不足 100 股',
  }
}

/** 返回当前价下可买或可卖的最大整手数量。 */
export function getFindFeelMaxQuantity(
  session: FindFeelSession,
  action: 'buy' | 'sell',
): number {
  if (session.phase === 'finished') return 0
  if (action === 'sell') return Math.max(0, Math.floor(session.shares / FIND_FEEL_QUANTITY) * FIND_FEEL_QUANTITY)
  const price = session.metrics.currentPrice
  if (!Number.isFinite(price) || price <= 0) return 0
  return Math.max(0, Math.floor((session.cash + 1e-8) / (price * FIND_FEEL_QUANTITY)) * FIND_FEEL_QUANTITY)
}

export function createFindFeelSession(options: FindFeelSessionOptions): FindFeelSession {
  const initialCash = Number(options.initialCash)
  const targetSteps = Number(options.targetSteps)
  if (!Number.isFinite(initialCash) || initialCash <= 0) throw new Error('本金必须大于 0。')
  if (!Number.isInteger(targetSteps) || targetSteps < 1) throw new Error('推进根数必须是大于 0 的整数。')
  if (!options.bars.length) throw new Error('当前范围内没有可用的已收盘 K 线。')

  const startIndex = resolveFindFeelStartIndex(options.bars, options)
  if (startIndex == null) throw new Error('无法确定调试的起始 K 线。')
  const startBar = options.bars[startIndex]
  const metrics = metricSnapshot(initialCash, initialCash, 0, startBar.close, initialCash)
  const finished = startIndex >= options.bars.length - 1
  return {
    initialCash,
    targetSteps,
    startBarKey: startBar.key,
    currentBarKey: startBar.key,
    currentIndex: startIndex,
    completedSteps: 0,
    phase: finished ? 'finished' : 'playing',
    endReason: finished ? 'no_next_bar' : undefined,
    cash: initialCash,
    shares: 0,
    metrics,
    history: [],
    equityCurve: [{ step: 0, barKey: startBar.key, equity: metrics.equity }],
  }
}

export function applyFindFeelAction(
  session: FindFeelSession,
  bars: FindFeelBar[],
  action: FindFeelAction,
  quantity = FIND_FEEL_QUANTITY,
): FindFeelActionResult {
  if (session.phase === 'finished') return { session, accepted: false, reason: '本局已结束。' }
  const bar = bars[session.currentIndex]
  if (!bar) return { session, accepted: false, reason: '找不到当前 K 线。' }

  const availability = getFindFeelActionAvailability(session, quantity)
  if (action === 'buy' && !availability.buy) return { session, accepted: false, reason: availability.buyReason }
  if (action === 'sell' && !availability.sell) return { session, accepted: false, reason: availability.sellReason }

  const executedQuantity = action === 'skip' ? 0 : normalizeFindFeelQuantity(quantity)
  const value = bar.close * executedQuantity
  const cash = action === 'buy' ? session.cash - value : action === 'sell' ? session.cash + value : session.cash
  const shares = action === 'buy' ? session.shares + executedQuantity : action === 'sell' ? session.shares - executedQuantity : session.shares
  const completedSteps = session.completedSteps + 1
  const nextIndex = session.currentIndex + 1
  const hasNext = nextIndex < bars.length
  const currentIndex = hasNext ? nextIndex : session.currentIndex
  const currentBar = bars[currentIndex]
  const phase: FindFeelPhase = !hasNext || completedSteps >= session.targetSteps ? 'finished' : 'playing'
  const endReason = !hasNext ? 'no_next_bar' : completedSteps >= session.targetSteps ? 'target_steps' : undefined
  const metrics = metricSnapshot(session.initialCash, cash, shares, currentBar.close, session.metrics.peakEquity)
  const decision: FindFeelDecision = {
    step: completedSteps,
    barKey: bar.key,
    action,
    price: bar.close,
    quantity: executedQuantity,
    executed: true,
    nextBarKey: hasNext ? currentBar.key : undefined,
  }
  return {
    accepted: true,
    session: {
      ...session,
      currentBarKey: currentBar.key,
      currentIndex,
      completedSteps,
      phase,
      endReason,
      cash,
      shares,
      metrics,
      history: [...session.history, decision],
      equityCurve: [...session.equityCurve, {
        step: completedSteps,
        barKey: currentBar.key,
        equity: metrics.equity,
        action,
      }],
    },
  }
}
