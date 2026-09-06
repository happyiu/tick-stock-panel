import type { ChanlunAnalysis, ChanlunFractal, ChanlunStructureSource } from '@/lib/chanlun'

export type PriceZoneSide = 'support' | 'resistance' | 'current'
export type PriceZoneSourceType = 'fractal' | 'stroke' | 'segment' | 'center' | 'ma20' | 'ma60'

export interface PriceZoneSource {
  type: PriceZoneSourceType
  label: string
  price: number
  date: string | null
}

export interface PriceZone {
  id: string
  side: PriceZoneSide
  low: number
  high: number
  center: number
  distancePct: number | null
  sources: PriceZoneSource[]
  sourceCount: number
  lastTouchTime: string | null
  period: ChanlunAnalysis['period']
  structureSource: ChanlunStructureSource
  ruleVersion: 'price-zone-v1'
  atrAvailable: boolean
}

interface PricePoint extends PriceZoneSource {
  eventKey: string
}

const PRICE_RATIO = 0.003
const ATR_RATIO = 0.3

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function fractalLabel(fractal: ChanlunFractal): string {
  return fractal.type === 'bottom' ? '底分型' : '顶分型'
}

function sourceEventKey(point: PriceZoneSource): string {
  // 分型、笔端点和线段端点落在同一根 K 线上时视为一个结构事件。
  return `${point.date ?? 'unknown'}|${point.price.toFixed(8)}`
}

function uniquePoints(points: PricePoint[]): PricePoint[] {
  const seen = new Set<string>()
  const result: PricePoint[] = []
  for (const point of points) {
    const key = point.eventKey
    if (seen.has(key)) continue
    seen.add(key)
    result.push(point)
  }
  return result
}

function dateValue(value: string | null): number {
  if (!value) return 0
  const parsed = Date.parse(value.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : 0
}

function sourceDate(points: PricePoint[]): string | null {
  return points
    .map(point => point.date)
    .filter((date): date is string => !!date)
    .sort((a, b) => dateValue(b) - dateValue(a))[0] ?? null
}

function addPoint(points: PricePoint[], source: PriceZoneSource) {
  if (!finitePositive(source.price)) return
  points.push({ ...source, eventKey: sourceEventKey(source) })
}

/**
 * 从已经按观察时点截断的缠论结果生成可追溯价位区间。
 * 这里只消费已确认结构和当前 K 线指标，不读取其它周期或未来数据。
 */
export function buildPriceZones(analysis: ChanlunAnalysis): PriceZone[] {
  const currentPrice = analysis.currentPrice
  if (!finitePositive(currentPrice)) return []

  const latestBar = analysis.bars.at(-1)
  const atr = latestBar?.atr14
  const atrAvailable = finitePositive(atr)
  const epsilon = Math.max(
    atrAvailable ? atr * ATR_RATIO : 0,
    currentPrice * PRICE_RATIO,
  )
  const points: PricePoint[] = []

  for (const fractal of analysis.fractals) {
    addPoint(points, {
      type: 'fractal',
      label: fractalLabel(fractal),
      price: fractal.price,
      date: fractal.date,
    })
  }

  for (const stroke of analysis.strokes.filter(item => item.confirmed)) {
    addPoint(points, {
      type: 'stroke',
      label: `${stroke.direction === 'up' ? '向上' : '向下'}笔端点`,
      price: stroke.endPrice,
      date: stroke.endDate,
    })
  }

  for (const segment of analysis.segments.filter(item => item.confirmed)) {
    addPoint(points, {
      type: 'segment',
      label: `${segment.direction === 'up' ? '向上' : '向下'}线段端点`,
      price: segment.endPrice,
      date: segment.endDate,
    })
  }

  const centers = analysis.centers
  for (const center of centers) {
    addPoint(points, { type: 'center', label: '中枢 ZD', price: center.zd, date: center.endDate })
    addPoint(points, { type: 'center', label: '中枢 ZG', price: center.zg, date: center.endDate })
  }

  if (finitePositive(latestBar?.ma20)) {
    addPoint(points, { type: 'ma20', label: 'MA20', price: latestBar.ma20, date: latestBar.date })
  }
  if (finitePositive(latestBar?.ma60)) {
    addPoint(points, { type: 'ma60', label: 'MA60', price: latestBar.ma60, date: latestBar.date })
  }

  const unique = uniquePoints(points).sort((a, b) => a.price - b.price)
  if (!unique.length) return []

  const clusters: PricePoint[][] = []
  for (const point of unique) {
    const current = clusters.at(-1)
    if (!current) {
      clusters.push([point])
      continue
    }
    const low = current[0].price
    const high = current[current.length - 1].price
    if (point.price - low <= epsilon && point.price - high <= epsilon) {
      current.push(point)
    } else {
      clusters.push([point])
    }
  }

  const zones = clusters.map((cluster, index): PriceZone => {
    const rawLow = Math.min(...cluster.map(point => point.price))
    const rawHigh = Math.max(...cluster.map(point => point.price))
    const isSingle = cluster.length === 1
    const low = isSingle ? rawLow - epsilon / 2 : rawLow
    const high = isSingle ? rawHigh + epsilon / 2 : rawHigh
    const side: PriceZoneSide = low <= currentPrice && currentPrice <= high
      ? 'current'
      : high < currentPrice ? 'support' : 'resistance'
    const distance = side === 'support'
      ? currentPrice - high
      : side === 'resistance' ? low - currentPrice : 0
    const sourceTypes = new Set(cluster.map(point => point.type))
    return {
      id: `price-zone-${analysis.period}-${analysis.source}-${index}`,
      side,
      low,
      high,
      center: (rawLow + rawHigh) / 2,
      distancePct: currentPrice > 0 ? Math.max(0, distance) / currentPrice : null,
      sources: cluster.map(({ eventKey: _eventKey, ...source }) => source),
      sourceCount: sourceTypes.size,
      lastTouchTime: sourceDate(cluster),
      period: analysis.period,
      structureSource: analysis.source,
      ruleVersion: 'price-zone-v1',
      atrAvailable,
    }
  })

  const supports = zones
    .filter(zone => zone.side === 'support')
    .sort((a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity))
    .slice(0, 2)
  const resistances = zones
    .filter(zone => zone.side === 'resistance')
    .sort((a, b) => (a.distancePct ?? Infinity) - (b.distancePct ?? Infinity))
    .slice(0, 2)
  const current = zones.find(zone => zone.side === 'current')
  return [...supports, ...resistances, ...(current ? [current] : [])]
    .sort((a, b) => a.center - b.center)
}

export function zoneSourcesSummary(zone: PriceZone): string {
  const labels = [...new Set(zone.sources.map(source => source.label))]
  if (!labels.length) return '无可追溯来源'
  return labels.join(' · ')
}
