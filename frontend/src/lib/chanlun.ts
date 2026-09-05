export type ChanlunDirection = 'up' | 'down'
export type ChanlunFractalType = 'top' | 'bottom'
export type ChanlunCenterState = 'oscillating' | 'extension' | 'broken_up' | 'broken_down'
export type ChanlunSignalKind = 'third_buy' | 'third_sell'
export type ChanlunSignalStatus = 'waiting_pullback' | 'candidate' | 'invalidated' | 'rejected'

export interface ChanlunBarInput {
  date: string
  open: number
  high: number
  low: number
  close: number
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
  centers: ChanlunCenter[]
  thirdSignals: ChanlunThirdSignal[]
  latestFractal: ChanlunFractal | null
  latestConfirmedStroke: ChanlunStroke | null
  formingStroke: ChanlunStroke | null
  latestCenter: ChanlunCenter | null
  latestSignal: ChanlunThirdSignal | null
  currentPrice: number | null
  pricePosition: 'inside' | 'above' | 'below' | null
}

const APPROXIMATION_LOSS = '未构建线段与多级别递归；中枢由笔重叠近似；三类候选缺少低级别确认'
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
    fractals.push({
      type,
      mergedIndex: index,
      sourceIndex: top ? current.highSourceIndex : current.lowSourceIndex,
      date,
      price,
      confirmedAt: stabilizer.endDate,
      confirmedSourceIndex: stabilizer.sourceEndIndex,
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

function overlapRange(strokes: ChanlunStroke[]): { zd: number; zg: number } | null {
  const zd = Math.max(...strokes.map(stroke => stroke.low))
  const zg = Math.min(...strokes.map(stroke => stroke.high))
  return zd <= zg ? { zd, zg } : null
}

function overlapsCenter(stroke: ChanlunStroke, zd: number, zg: number): boolean {
  return stroke.low <= zg && stroke.high >= zd
}

/** 用连续三条已确认笔的固定交集构建近似中枢。 */
export function buildChanlunCenters(strokes: ChanlunStroke[]): ChanlunCenter[] {
  const confirmed = strokes.filter(stroke => stroke.confirmed)
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
      : end - start + 1 > 3 ? 'extension' : 'oscillating'
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
    })

    if (!outside) break
    start = cursor
  }
  return centers
}

function qualifiesLeave(stroke: ChanlunStroke, center: ChanlunCenter): ChanlunSignalKind | null {
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
  strokes: ChanlunStroke[],
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
      const invalidatedAt = findInvalidation(bars, availableDate, kind, boundary)
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

function emptyAnalysis(status: ChanlunAnalysis['status'], bars: ChanlunBarInput[], issues: string[]): ChanlunAnalysis {
  return {
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
    centers: [],
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
export function analyzeChanlun(input: ChanlunBarInput[], asOf?: string | null): ChanlunAnalysis {
  const cutoffIndex = asOf ? input.findIndex(bar => bar.date === asOf) : -1
  const bars = asOf
    ? cutoffIndex >= 0 ? input.slice(0, cutoffIndex + 1) : input.filter(bar => bar.date <= asOf)
    : [...input]
  if (!bars.length) return emptyAnalysis('insufficient', bars, ['暂无当前周期 K 线'])

  const invalidIndex = bars.findIndex((bar, index) => !isFiniteBar(bar)
    || (index > 0 && bar.date <= bars[index - 1].date))
  if (invalidIndex >= 0) {
    return emptyAnalysis('invalid_data', bars, [`第 ${invalidIndex + 1} 根 K 线字段异常或时间未严格递增`])
  }

  const mergedBars = mergeChanlunBars(bars)
  const fractals = detectChanlunFractals(mergedBars)
  const strokes = buildChanlunStrokes(fractals, mergedBars)
  const centers = buildChanlunCenters(strokes)
  const thirdSignals = detectChanlunThirdSignals(centers, strokes, bars)
  const latestCenter = centers.at(-1) ?? null
  const currentPrice = bars.at(-1)?.close ?? null
  const pricePosition = latestCenter && currentPrice != null
    ? currentPrice > latestCenter.zg ? 'above' : currentPrice < latestCenter.zd ? 'below' : 'inside'
    : null
  const confirmedStrokes = strokes.filter(stroke => stroke.confirmed)
  return {
    definitionMode: 'structure_proxy',
    approximationLoss: APPROXIMATION_LOSS,
    status: strokes.length > 0 ? 'ready' : 'insufficient',
    issues: strokes.length > 0 ? [] : ['尚未形成满足间距要求的有效笔'],
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
    centers,
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
