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
}

export interface ChanlunCenter {
  id: string
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
}

export interface ChanlunCondition {
  id: 'center' | 'leave' | 'pullback' | 'outside' | 'lower_level' | 'context' | 'divergence' | 'rebound'
  label: string
  state: ChanlunConditionState
  evidence: string
}

export interface ChanlunDivergence {
  id: string
  kind: 'trend' | 'consolidation'
  direction: ChanlunDirection
  status: 'candidate' | 'not_found' | 'unavailable'
  source: ChanlunStructureSource
  movementAIndex: number
  movementCIndex: number
  a: { startDate: string; endDate: string; changePct: number | null; bars: number; force: number | null; macdArea: number | null }
  c: { startDate: string; endDate: string; changePct: number | null; bars: number; force: number | null; macdArea: number | null }
  evidence: string
}

export interface ChanlunCandidateSignal {
  id: string
  kind: ChanlunCandidateKind
  status: ChanlunSignalStatus
  source: ChanlunStructureSource
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

export interface ChanlunAnalysis {
  ruleVersion: 2
  period: '30m' | '1d' | '1w' | '1mo'
  source: ChanlunStructureSource
  definitionMode: 'structure_proxy'
  approximationLoss: string
  status: 'ready' | 'insufficient' | 'invalid_data'
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
  candidateSignals: ChanlunCandidateSignal[]
  thirdSignals: ChanlunThirdSignal[]
  latestFractal: ChanlunFractal | null
  latestConfirmedStroke: ChanlunStroke | null
  formingStroke: ChanlunStroke | null
  latestCenter: ChanlunCenter | null
  latestSignal: ChanlunThirdSignal | null
  currentPrice: number | null
  pricePosition: 'inside' | 'above' | 'below' | null
}

const APPROXIMATION_LOSS = '未实现严格特征序列与走势递归；线段、中枢、背驰和买卖点均为可复现结构代理；低级别递归确认缺失'
const MIN_STROKE_GAP = 4

function isFiniteBar(bar: ChanlunBarInput): boolean {
  return !!bar.date
    && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
    && bar.high >= bar.low
}

function relation(a: Pick<ChanlunMergedBar, 'high' | 'low'>, b: Pick<ChanlunMergedBar, 'high' | 'low'>): ChanlunDirection | 'containment' {
  const contains = (a.high >= b.high && a.low <= b.low)
    || (b.high >= a.high && b.low <= a.low)
  if (contains) return 'containment'
  return b.high > a.high && b.low > a.low ? 'up' : 'down'
}

function rawMergedBar(bar: ChanlunBarInput, sourceIndex: number, direction: ChanlunDirection | 'unknown', uncertain: boolean): ChanlunMergedBar {
  return {
    sourceStartIndex: sourceIndex,
    sourceEndIndex: sourceIndex,
    startDate: bar.date,
    endDate: bar.date,
    high: bar.high,
    low: bar.low,
    highDate: bar.date,
    lowDate: bar.date,
    highSourceIndex: sourceIndex,
    lowSourceIndex: sourceIndex,
    direction,
    uncertain,
    closed: bar.isClosed === true,
    periodEnd: bar.periodEnd ?? bar.date,
  }
}

function mergeContainedBar(last: ChanlunMergedBar, bar: ChanlunBarInput, sourceIndex: number, direction: ChanlunDirection | 'unknown'): ChanlunMergedBar {
  if (direction === 'up') {
    const useNewHigh = bar.high > last.high
    const useNewLow = bar.low > last.low
    return {
      ...last,
      sourceEndIndex: sourceIndex,
      endDate: bar.date,
      high: Math.max(last.high, bar.high),
      low: Math.max(last.low, bar.low),
      highDate: useNewHigh ? bar.date : last.highDate,
      lowDate: useNewLow ? bar.date : last.lowDate,
      highSourceIndex: useNewHigh ? sourceIndex : last.highSourceIndex,
      lowSourceIndex: useNewLow ? sourceIndex : last.lowSourceIndex,
      direction,
      closed: last.closed,
      periodEnd: last.periodEnd,
    }
  }
  if (direction === 'down') {
    const useNewHigh = bar.high < last.high
    const useNewLow = bar.low < last.low
    return {
      ...last,
      sourceEndIndex: sourceIndex,
      endDate: bar.date,
      high: Math.min(last.high, bar.high),
      low: Math.min(last.low, bar.low),
      highDate: useNewHigh ? bar.date : last.highDate,
      lowDate: useNewLow ? bar.date : last.lowDate,
      highSourceIndex: useNewHigh ? sourceIndex : last.highSourceIndex,
      lowSourceIndex: useNewLow ? sourceIndex : last.lowSourceIndex,
      direction,
      closed: last.closed,
      periodEnd: last.periodEnd,
    }
  }
  const useNewHigh = bar.high > last.high
  const useNewLow = bar.low < last.low
  return {
    ...last,
    sourceEndIndex: sourceIndex,
    endDate: bar.date,
    high: Math.max(last.high, bar.high),
    low: Math.min(last.low, bar.low),
    highDate: useNewHigh ? bar.date : last.highDate,
    lowDate: useNewLow ? bar.date : last.lowDate,
    highSourceIndex: useNewHigh ? sourceIndex : last.highSourceIndex,
    lowSourceIndex: useNewLow ? sourceIndex : last.lowSourceIndex,
    direction: 'unknown',
    uncertain: true,
    closed: last.closed,
    periodEnd: last.periodEnd,
  }
}

/** 按当前方向处理包含关系；开头无法定向的包含链保留为 uncertain，不参与分型确认。 */
export function mergeChanlunBars(bars: ChanlunBarInput[]): ChanlunMergedBar[] {
  if (!bars.length) return []
  const merged: ChanlunMergedBar[] = [rawMergedBar(bars[0], 0, 'unknown', true)]
  let direction: ChanlunDirection | 'unknown' = 'unknown'

  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index]
    const last = merged[merged.length - 1]
    const nextRelation = relation(last, bar)
    if (nextRelation === 'containment') {
      merged[merged.length - 1] = mergeContainedBar(last, bar, index, direction)
      continue
    }
    direction = nextRelation
    merged.push(rawMergedBar(bar, index, direction, false))
  }
  return merged
}

/** 只确认严格三 K 分型；尾部再出现一根非包含 K 后，右侧 K 才不会继续被合并。 */
export function detectChanlunFractals(mergedBars: ChanlunMergedBar[]): ChanlunFractal[] {
  const fractals: ChanlunFractal[] = []
  for (let index = 1; index < mergedBars.length - 2; index += 1) {
    const previous = mergedBars[index - 1]
    const current = mergedBars[index]
    const next = mergedBars[index + 1]
    if (previous.uncertain || current.uncertain || next.uncertain) continue
    const top = current.high > previous.high && current.high > next.high
      && current.low > previous.low && current.low > next.low
    const bottom = current.low < previous.low && current.low < next.low
      && current.high < previous.high && current.high < next.high
    if (!top && !bottom) continue
    const type: ChanlunFractalType = top ? 'top' : 'bottom'
    const date = top ? current.highDate : current.lowDate
    const price = top ? current.high : current.low
    const stabilizer = mergedBars[index + 2]
    if (!previous.closed || !current.closed || !next.closed || !stabilizer.closed) continue
    fractals.push({
      type,
      mergedIndex: index,
      sourceIndex: top ? current.highSourceIndex : current.lowSourceIndex,
      date,
      price,
      // 使用稳定 K 的起点，而不是可能继续吸收包含 K 的末端，避免确认时间随后续行情漂移。
      confirmedAt: stabilizer.periodEnd,
      confirmedSourceIndex: stabilizer.sourceStartIndex,
    })
  }
  return fractals
}

function isMoreExtreme(candidate: ChanlunFractal, current: ChanlunFractal): boolean {
  return candidate.type === 'top' ? candidate.price > current.price : candidate.price < current.price
}

function isValidStrokePair(start: ChanlunFractal, end: ChanlunFractal, mergedBars: ChanlunMergedBar[]): boolean {
  if (start.type === end.type || end.mergedIndex - start.mergedIndex < MIN_STROKE_GAP) return false
  const bottom = start.type === 'bottom' ? start : end
  const top = start.type === 'top' ? start : end
  if (top.price <= bottom.price) return false
  const interval = mergedBars.slice(start.mergedIndex, end.mergedIndex + 1)
  if (!interval.length) return false
  const intervalHigh = Math.max(...interval.map(bar => bar.high))
  const intervalLow = Math.min(...interval.map(bar => bar.low))
  return top.price >= intervalHigh && bottom.price <= intervalLow
}

/** 构建交替分型笔；最后一笔需等待下一条有效反向笔，因此标记为形成中。 */
export function buildChanlunStrokes(fractals: ChanlunFractal[], mergedBars: ChanlunMergedBar[]): ChanlunStroke[] {
  const endpoints: ChanlunFractal[] = []
  for (const fractal of fractals) {
    const last = endpoints.at(-1)
    if (!last) {
      endpoints.push(fractal)
      continue
    }
    if (last.type === fractal.type) {
      if (!isMoreExtreme(fractal, last)) continue
      const previous = endpoints.at(-2)
      if (!previous || isValidStrokePair(previous, fractal, mergedBars)) {
        endpoints[endpoints.length - 1] = fractal
      }
      continue
    }
    if (isValidStrokePair(last, fractal, mergedBars)) endpoints.push(fractal)
  }

  const strokes: ChanlunStroke[] = []
  for (let index = 0; index < endpoints.length - 1; index += 1) {
    const start = endpoints[index]
    const end = endpoints[index + 1]
    const direction: ChanlunDirection = start.type === 'bottom' ? 'up' : 'down'
    const confirmed = index < endpoints.length - 2
    const nextEndpoint = endpoints[index + 2]
    const low = Math.min(start.price, end.price)
    const high = Math.max(start.price, end.price)
    strokes.push({
      id: `stroke-${index}-${start.date}-${end.date}`,
      index,
      direction,
      start,
      end,
      startDate: start.date,
      endDate: end.date,
      startPrice: start.price,
      endPrice: end.price,
      low,
      high,
      mergedBars: end.mergedIndex - start.mergedIndex + 1,
      changePct: start.price > 0 ? end.price / start.price - 1 : null,
      confirmed,
      confirmedAt: confirmed ? nextEndpoint.confirmedAt : null,
    })
  }
  return strokes
}

/**
 * 可复现的线段代理：以三条连续已确认笔且存在共同重叠为起点；反向笔突破前一条
 * 同向反向笔端点时确认当前段。它不实现严格特征序列和缺口规则。
 */
export function buildChanlunSegments(strokes: ChanlunStroke[]): ChanlunSegment[] {
  const confirmed = strokes.filter(stroke => stroke.confirmed)
  const result: ChanlunSegment[] = []
  let start = 0
  while (start + 2 < confirmed.length) {
    const seed = confirmed.slice(start, start + 3)
    if (!overlapRange(seed)) {
      start += 1
      continue
    }
    const direction = seed[0].direction
    let end = start + 2
    let confirmedAt: string | null = null
    let cursor = start + 3
    for (; cursor < confirmed.length; cursor += 1) {
      const movement = confirmed[cursor]
      const previousSame = confirmed.slice(start, cursor).reverse().find(item => item.direction === movement.direction)
      const breaks = movement.direction !== direction && previousSame
        ? direction === 'up'
          ? movement.endPrice < previousSame.endPrice
          : movement.endPrice > previousSame.endPrice
        : false
      if (breaks) {
        confirmedAt = movement.confirmedAt
        break
      }
      end = cursor
    }
    const components = confirmed.slice(start, end + 1)
    const first = components[0]
    const last = components.at(-1)!
    const startPrice = first.startPrice
    const directionalEnds = components.filter(item => item.direction === direction)
    const endPrice = direction === 'up'
      ? Math.max(...directionalEnds.map(item => item.endPrice))
      : Math.min(...directionalEnds.map(item => item.endPrice))
    const endMovement = [...directionalEnds].reverse().find(item => item.endPrice === endPrice) ?? last
    result.push({
      id: `segment-${result.length}-${first.startDate}`,
      index: result.length,
      direction,
      startStrokeIndex: first.index,
      endStrokeIndex: last.index,
      startDate: first.startDate,
      endDate: endMovement.endDate,
      startPrice,
      endPrice,
      low: Math.min(...components.map(item => item.low)),
      high: Math.max(...components.map(item => item.high)),
      componentCount: components.length,
      bars: components.reduce((sum, item) => sum + Math.max(1, item.mergedBars - 1), 1),
      changePct: startPrice > 0 ? endPrice / startPrice - 1 : null,
      confirmed: confirmedAt != null,
      confirmedAt,
    })
    if (!confirmedAt) break
    start = cursor
  }
  return result
}

function overlapRange(strokes: Array<Pick<ChanlunStroke, 'low' | 'high'>>): { zd: number; zg: number } | null {
  const zd = Math.max(...strokes.map(stroke => stroke.low))
  const zg = Math.min(...strokes.map(stroke => stroke.high))
  return zd <= zg ? { zd, zg } : null
}

function overlapsCenter(stroke: Pick<ChanlunStroke, 'low' | 'high'>, zd: number, zg: number): boolean {
  return stroke.low <= zg && stroke.high >= zd
}

/** 用连续三条已确认笔的固定交集构建近似中枢。 */
type CenterUnit = Pick<ChanlunStroke, 'index' | 'direction' | 'startDate' | 'endDate' | 'startPrice' | 'endPrice' | 'low' | 'high' | 'confirmed' | 'confirmedAt'> & {
  mergedBars?: number
  bars?: number
}

function buildCentersFromUnits(units: CenterUnit[], source: ChanlunStructureSource): ChanlunCenter[] {
  const confirmed = units.filter(unit => unit.confirmed)
  const centers: ChanlunCenter[] = []
  let start = 0

  while (start + 2 < confirmed.length) {
    const initial = confirmed.slice(start, start + 3)
    const overlap = overlapRange(initial)
    if (!overlap) {
      start += 1
      continue
    }

    let end = start + 2
    let cursor = end + 1
    let gg = Math.max(...initial.map(stroke => stroke.high))
    let dd = Math.min(...initial.map(stroke => stroke.low))
    while (cursor < confirmed.length && overlapsCenter(confirmed[cursor], overlap.zd, overlap.zg)) {
      gg = Math.max(gg, confirmed[cursor].high)
      dd = Math.min(dd, confirmed[cursor].low)
      end = cursor
      cursor += 1
    }

    const outside = confirmed[cursor]
    const state: ChanlunCenterState = outside
      ? outside.low > overlap.zg ? 'broken_up' : outside.high < overlap.zd ? 'broken_down' : 'oscillating'
      : end - start + 1 > 3 ? 'extension' : centers.length > 0 ? 'newborn' : 'oscillating'
    centers.push({
      id: `center-${centers.length}-${initial[0].startDate}`,
      startStrokeIndex: initial[0].index,
      endStrokeIndex: confirmed[end].index,
      startDate: initial[0].startDate,
      endDate: confirmed[end].endDate,
      formedAt: initial[2].confirmedAt ?? initial[2].endDate,
      zd: overlap.zd,
      zg: overlap.zg,
      dd,
      gg,
      componentCount: end - start + 1,
      state,
      source,
    })

    if (!outside) break
    start = cursor
  }
  return centers
}

export function buildChanlunCenters(strokes: ChanlunStroke[]): ChanlunCenter[] {
  return buildCentersFromUnits(strokes, 'stroke')
}

export function buildChanlunSegmentCenters(segments: ChanlunSegment[]): ChanlunCenter[] {
  return buildCentersFromUnits(segments, 'segment')
}

export function classifyChanlunTrend(centers: ChanlunCenter[]): ChanlunTrendType {
  if (!centers.length) return 'unclear'
  if (centers.length === 1) return 'consolidation_proxy'
  const previous = centers.at(-2)!
  const latest = centers.at(-1)!
  if (latest.zd > previous.zg) return 'uptrend_proxy'
  if (latest.zg < previous.zd) return 'downtrend_proxy'
  return 'consolidation_proxy'
}

function qualifiesLeave(stroke: CenterUnit, center: ChanlunCenter): ChanlunSignalKind | null {
  if (stroke.direction === 'up' && stroke.startPrice <= center.zg && stroke.endPrice > center.zg) return 'third_buy'
  if (stroke.direction === 'down' && stroke.startPrice >= center.zd && stroke.endPrice < center.zd) return 'third_sell'
  return null
}

function findDateIndex(bars: ChanlunBarInput[], date: string): number {
  return bars.findIndex(bar => bar.date === date)
}

function findInvalidation(
  bars: ChanlunBarInput[],
  availableDate: string,
  kind: ChanlunSignalKind,
  boundary: number,
): string | null {
  const availableIndex = findDateIndex(bars, availableDate)
  if (availableIndex < 0) return null
  for (let index = availableIndex + 1; index < bars.length; index += 1) {
    const bar = bars[index]
    if (kind === 'third_buy' ? bar.low <= boundary : bar.high >= boundary) return bar.date
  }
  return null
}

/** 三类候选只由中枢离开和其后已确认反向笔判定，不使用 MA/MACD 等指标补足。 */
export function detectChanlunThirdSignals(
  centers: ChanlunCenter[],
  strokes: CenterUnit[],
  bars: ChanlunBarInput[],
): ChanlunThirdSignal[] {
  const signals: ChanlunThirdSignal[] = []
  for (const center of centers) {
    for (let index = center.startStrokeIndex + 2; index <= center.endStrokeIndex; index += 1) {
      const leave = strokes[index]
      if (!leave?.confirmed) continue
      const kind = qualifiesLeave(leave, center)
      if (!kind) continue
      const pullback = strokes[index + 1]
      const boundary = kind === 'third_buy' ? center.zg : center.zd
      if (!pullback?.confirmed) {
        signals.push({
          id: `${center.id}-${kind}-${leave.index}`,
          centerId: center.id,
          kind,
          status: 'waiting_pullback',
          structureDate: leave.endDate,
          availableDate: leave.confirmedAt ?? leave.endDate,
          price: leave.endPrice,
          boundary,
          leaveStrokeIndex: leave.index,
          pullbackStrokeIndex: pullback?.index ?? null,
          invalidatedAt: null,
          lowerLevelTrigger: 'missing',
        })
        continue
      }
      const validPullback = kind === 'third_buy'
        ? pullback.direction === 'down' && pullback.low > center.zg
        : pullback.direction === 'up' && pullback.high < center.zd
      const availableDate = pullback.confirmedAt ?? pullback.endDate
      if (!validPullback) {
        signals.push({
          id: `${center.id}-${kind}-${leave.index}`,
          centerId: center.id,
          kind,
          status: 'rejected',
          structureDate: pullback.endDate,
          availableDate,
          price: pullback.endPrice,
          boundary,
          leaveStrokeIndex: leave.index,
          pullbackStrokeIndex: pullback.index,
          invalidatedAt: null,
          lowerLevelTrigger: 'missing',
        })
        continue
      }
      // 回抽结构发生后到其最早可知时间之间也可能已经触界；此时不能产生“刚确认即有效”的候选。
      const invalidationStart = findDateIndex(bars, pullback.endDate) >= 0 ? pullback.endDate : availableDate
      const invalidatedAt = findInvalidation(bars, invalidationStart, kind, boundary)
      signals.push({
        id: `${center.id}-${kind}-${leave.index}`,
        centerId: center.id,
        kind,
        status: invalidatedAt ? 'invalidated' : 'candidate',
        structureDate: pullback.endDate,
        availableDate,
        price: pullback.endPrice,
        boundary,
        leaveStrokeIndex: leave.index,
        pullbackStrokeIndex: pullback.index,
        invalidatedAt,
        lowerLevelTrigger: 'missing',
      })
    }
  }
  return signals
}

function movementBars(movement: CenterUnit | ChanlunSegment): number {
  const count = 'mergedBars' in movement ? movement.mergedBars : movement.bars
  return Math.max(1, Number(count ?? 1))
}

function macdArea(bars: ChanlunBarInput[], startDate: string, endDate: string): number | null {
  const values = bars
    .filter(bar => bar.date >= startDate && bar.date <= endDate && Number.isFinite(bar.macdHist ?? bar.macd_hist))
    .map(bar => Math.abs(Number(bar.macdHist ?? bar.macd_hist)))
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null
}

/** 只比较同来源、同方向且位于同一中枢两侧的走势单元。 */
export function detectChanlunDivergences(
  centers: ChanlunCenter[],
  units: Array<CenterUnit | ChanlunSegment>,
  bars: ChanlunBarInput[],
  source: ChanlunStructureSource,
): ChanlunDivergence[] {
  const result: ChanlunDivergence[] = []
  const trendType = classifyChanlunTrend(centers)
  for (const center of centers) {
    const after = units.find(unit => unit.confirmed && unit.index > center.endStrokeIndex)
    if (!after) continue
    const before = [...units].reverse().find(unit => (
      unit.confirmed && unit.index < center.startStrokeIndex && unit.direction === after.direction
    ))
    if (!before) continue
    const aBars = movementBars(before)
    const cBars = movementBars(after)
    const aChange = before.startPrice > 0 ? before.endPrice / before.startPrice - 1 : null
    const cChange = after.startPrice > 0 ? after.endPrice / after.startPrice - 1 : null
    const aForce = aChange == null ? null : Math.abs(aChange) / aBars
    const cForce = cChange == null ? null : Math.abs(cChange) / cBars
    const newExtreme = after.direction === 'down'
      ? after.endPrice < before.endPrice
      : after.endPrice > before.endPrice
    const weakened = aForce != null && cForce != null && cForce < aForce
    const candidate = newExtreme && weakened
    result.push({
      id: `divergence-${source}-${center.id}-${after.index}`,
      kind: trendType === 'uptrend_proxy' || trendType === 'downtrend_proxy' ? 'trend' : 'consolidation',
      direction: after.direction,
      status: candidate ? 'candidate' : 'not_found',
      source,
      movementAIndex: before.index,
      movementCIndex: after.index,
      a: {
        startDate: before.startDate,
        endDate: before.endDate,
        changePct: aChange,
        bars: aBars,
        force: aForce,
        macdArea: macdArea(bars, before.startDate, before.endDate),
      },
      c: {
        startDate: after.startDate,
        endDate: after.endDate,
        changePct: cChange,
        bars: cBars,
        force: cForce,
        macdArea: macdArea(bars, after.startDate, after.endDate),
      },
      evidence: !newExtreme
        ? 'C 段未创新极值'
        : weakened ? 'C 段创新极值且单位 K 线价格力度弱于 A 段' : 'C 段创新极值，但价格力度未弱于 A 段',
    })
  }
  return result
}

function condition(
  id: ChanlunCondition['id'],
  label: string,
  state: ChanlunConditionState,
  evidence: string,
): ChanlunCondition {
  return { id, label, state, evidence }
}

/** 把结构证据映射成可解释的一、二类候选；三类候选由既有离开/回抽链转换。 */
export function buildChanlunCandidateSignals(
  divergences: ChanlunDivergence[],
  units: Array<CenterUnit | ChanlunSegment>,
  thirdSignals: ChanlunThirdSignal[],
  bars: ChanlunBarInput[],
  source: ChanlunStructureSource,
): ChanlunCandidateSignal[] {
  const result: ChanlunCandidateSignal[] = []
  for (const divergence of divergences.filter(item => item.status === 'candidate')) {
    const movement = units.find(unit => unit.index === divergence.movementCIndex)
    if (!movement) continue
    const buySide = divergence.direction === 'down'
    const boundary = movement.endPrice
    const availableDate = movement.confirmedAt ?? movement.endDate
    const invalidatedAt = findInvalidation(bars, availableDate, buySide ? 'third_buy' : 'third_sell', boundary)
    const first: ChanlunCandidateSignal = {
      id: `first-${source}-${movement.index}`,
      kind: buySide ? 'first_buy' : 'first_sell',
      status: invalidatedAt ? 'invalidated' : 'candidate',
      source,
      structureDate: movement.endDate,
      availableDate,
      price: movement.endPrice,
      boundary,
      invalidatedAt,
      relatedSignalId: divergence.id,
      origin: divergence.kind === 'trend' ? 'trend_divergence' : 'consolidation_divergence',
      conditions: [
        condition('context', buySide ? '下跌结构' : '上涨结构', 'met', `${divergence.kind === 'trend' ? '趋势' : '盘整'}结构代理成立`),
        condition('divergence', '同级走势力度减弱', 'met', divergence.evidence),
        condition('lower_level', '低级别转折确认', 'unavailable', '尚未实现严格多级别递归确认'),
      ],
      nextWatch: buySide ? '等待反向上涨结构可知，并观察候选低点是否守住' : '等待反向下跌结构可知，并观察候选高点是否守住',
    }
    result.push(first)

    const rebound = units.find(unit => unit.index === movement.index + 1 && unit.confirmed && unit.direction !== movement.direction)
    const pullback = units.find(unit => unit.index === movement.index + 2 && unit.confirmed && unit.direction === movement.direction)
    if (!rebound) continue
    if (!pullback) continue
    const holds = buySide ? pullback.endPrice > boundary : pullback.endPrice < boundary
    const secondAvailable = pullback.confirmedAt ?? pullback.endDate
    const secondInvalidation = holds
      ? findInvalidation(bars, secondAvailable, buySide ? 'third_buy' : 'third_sell', boundary)
      : pullback.endDate
    result.push({
      id: `second-${source}-${movement.index}`,
      kind: buySide ? 'second_buy' : 'second_sell',
      status: holds ? secondInvalidation ? 'invalidated' : 'candidate' : 'rejected',
      source,
      structureDate: pullback.endDate,
      availableDate: secondAvailable,
      price: pullback.endPrice,
      boundary,
      invalidatedAt: secondInvalidation,
      relatedSignalId: first.id,
      origin: first.origin,
      conditions: [
        condition('context', buySide ? '一买候选存在' : '一卖候选存在', 'met', first.id),
        condition('rebound', '首次反向运动完成', 'met', `${rebound.startDate} → ${rebound.endDate}`),
        condition('pullback', '首次回抽完成', 'met', `${pullback.startDate} → ${pullback.endDate}`),
        condition('outside', buySide ? '回抽不破一买低点' : '回抽不破一卖高点', holds ? 'met' : 'failed', `边界 ${boundary}`),
        condition('lower_level', '低级别结构确认', 'unavailable', '尚未实现严格多级别递归确认'),
      ],
      nextWatch: holds ? '观察回抽后的反向结构以及失效边界' : '结构边界已被破坏',
    })
  }

  for (const signal of thirdSignals) {
    const buySide = signal.kind === 'third_buy'
    const hasPullback = signal.pullbackStrokeIndex != null
    const pullbackComplete = hasPullback && signal.status !== 'waiting_pullback'
    const outside = signal.status === 'candidate'
    result.push({
      id: signal.id,
      kind: signal.kind,
      status: signal.status,
      source,
      structureDate: signal.structureDate,
      availableDate: signal.availableDate,
      price: signal.price,
      boundary: signal.boundary,
      invalidatedAt: signal.invalidatedAt,
      relatedSignalId: signal.centerId,
      origin: 'third_structure',
      conditions: [
        condition('center', '有效中枢成立', 'met', signal.centerId),
        condition('leave', buySide ? '向上离开中枢' : '向下离开中枢', 'met', `离开单元 #${signal.leaveStrokeIndex + 1}`),
        condition('pullback', '首次回抽完成', pullbackComplete ? 'met' : 'waiting', pullbackComplete ? `回抽单元 #${signal.pullbackStrokeIndex! + 1}` : hasPullback ? `回抽单元 #${signal.pullbackStrokeIndex! + 1} 尚未确认` : '等待反向结构确认'),
        condition('outside', buySide ? '回抽低点高于 ZG' : '回抽高点低于 ZD', outside ? 'met' : pullbackComplete ? 'failed' : 'waiting', signal.invalidatedAt ? `${signal.invalidatedAt} 触及边界 ${signal.boundary}` : `边界 ${signal.boundary}`),
        condition('lower_level', '低级别结构确认', 'unavailable', '尚未实现严格多级别递归确认'),
      ],
      nextWatch: !pullbackComplete ? '等待首次回抽确认' : outside ? '观察失效边界和低级别转折' : '回抽已重新进入中枢',
    })
  }
  return result.sort((a, b) => a.availableDate.localeCompare(b.availableDate))
}

export interface ChanlunAnalyzeOptions {
  period?: ChanlunAnalysis['period']
  source?: ChanlunStructureSource
}

function emptyAnalysis(
  status: ChanlunAnalysis['status'],
  bars: ChanlunBarInput[],
  issues: string[],
  options: ChanlunAnalyzeOptions,
): ChanlunAnalysis {
  const period = options.period ?? '1d'
  const source = options.source ?? 'stroke'
  return {
    ruleVersion: 2,
    period,
    source,
    definitionMode: 'structure_proxy',
    approximationLoss: APPROXIMATION_LOSS,
    status,
    issues,
    window: {
      start: bars[0]?.date ?? null,
      end: bars.at(-1)?.date ?? null,
      bars: bars.length,
      mergedBars: 0,
    },
    bars,
    mergedBars: [],
    fractals: [],
    strokes: [],
    segments: [],
    centers: [],
    strokeCenters: [],
    segmentCenters: [],
    trendType: 'unclear',
    divergences: [],
    candidateSignals: [],
    thirdSignals: [],
    latestFractal: null,
    latestConfirmedStroke: null,
    formingStroke: null,
    latestCenter: null,
    latestSignal: null,
    currentPrice: bars.at(-1)?.close ?? null,
    pricePosition: null,
  }
}

/** asOf 会在任何结构计算前截断输入，保证历史截面不读取未来 K 线。 */
export function analyzeChanlun(
  input: ChanlunBarInput[],
  asOf?: string | null,
  options: ChanlunAnalyzeOptions = {},
): ChanlunAnalysis {
  const cutoffIndex = asOf ? input.findIndex(bar => bar.date === asOf) : -1
  const bars = asOf
    ? cutoffIndex >= 0 ? input.slice(0, cutoffIndex + 1) : input.filter(bar => bar.date <= asOf)
    : [...input]
  if (!bars.length) return emptyAnalysis('insufficient', bars, ['暂无当前周期 K 线'], options)

  const invalidIndex = bars.findIndex((bar, index) => !isFiniteBar(bar)
    || (index > 0 && bar.date <= bars[index - 1].date))
  if (invalidIndex >= 0) {
    return emptyAnalysis('invalid_data', bars, [`第 ${invalidIndex + 1} 根 K 线字段异常或时间未严格递增`], options)
  }

  // 形成中的价格仍用于位置展示，但结构确认只读取已闭合 K 线。
  const structureBars = bars.filter(bar => bar.isClosed === true)
  const mergedBars = mergeChanlunBars(structureBars)
  const fractals = detectChanlunFractals(mergedBars)
  const strokes = buildChanlunStrokes(fractals, mergedBars)
  const segments = buildChanlunSegments(strokes)
  const strokeCenters = buildChanlunCenters(strokes)
  const segmentCenters = buildChanlunSegmentCenters(segments)
  const source = options.source ?? 'stroke'
  const centers = source === 'segment' ? segmentCenters : strokeCenters
  const units: Array<CenterUnit | ChanlunSegment> = source === 'segment' ? segments : strokes
  const thirdSignals = detectChanlunThirdSignals(centers, units, bars)
  const trendType = classifyChanlunTrend(centers)
  const divergences = detectChanlunDivergences(centers, units, bars, source)
  const candidateSignals = buildChanlunCandidateSignals(divergences, units, thirdSignals, bars, source)
  const latestCenter = centers.at(-1) ?? null
  const currentPrice = bars.at(-1)?.close ?? null
  const pricePosition = latestCenter && currentPrice != null
    ? currentPrice > latestCenter.zg ? 'above' : currentPrice < latestCenter.zd ? 'below' : 'inside'
    : null
  const confirmedStrokes = strokes.filter(stroke => stroke.confirmed)
  return {
    ruleVersion: 2,
    period: options.period ?? '1d',
    source,
    definitionMode: 'structure_proxy',
    approximationLoss: APPROXIMATION_LOSS,
    status: strokes.length > 0 ? 'ready' : 'insufficient',
    issues: strokes.length > 0
      ? bars.some(bar => bar.isClosed !== true) ? ['末根 K 线尚未闭合或闭合状态未知，仅参与形成中展示'] : []
      : bars.some(bar => bar.isClosed !== true)
        ? ['尚未形成满足间距要求的有效笔；未闭合 K 线不参与确认']
        : ['尚未形成满足间距要求的有效笔'],
    window: {
      start: bars[0].date,
      end: bars.at(-1)?.date ?? null,
      bars: bars.length,
      mergedBars: mergedBars.length,
    },
    bars,
    mergedBars,
    fractals,
    strokes,
    segments,
    centers,
    strokeCenters,
    segmentCenters,
    trendType,
    divergences,
    candidateSignals,
    thirdSignals,
    latestFractal: fractals.at(-1) ?? null,
    latestConfirmedStroke: confirmedStrokes.at(-1) ?? null,
    formingStroke: strokes.at(-1)?.confirmed === false ? strokes.at(-1) ?? null : null,
    latestCenter,
    latestSignal: thirdSignals.at(-1) ?? null,
    currentPrice,
    pricePosition,
  }
}
