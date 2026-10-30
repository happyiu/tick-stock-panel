import type { OverlayCreate, OverlayTemplate } from 'klinecharts'
import type { ChartBar } from './kline-chart'
import type { PatternHit } from './trendPatterns'
import { chanlunTemplate } from './kline-chart-chanlun'
import { buildAnnotations } from './kline-chart-overlays'

export const patternZoneTemplate: OverlayTemplate = {
  name: 'TSP_PATTERN_ZONE', totalStep: 1,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates }) => {
    const [a, b] = coordinates
    return a && b ? [{ type: 'rect', attrs: { x: Math.min(a.x, b.x) - 3, y: Math.min(a.y, b.y), width: Math.max(6, Math.abs(b.x - a.x)), height: Math.max(2, Math.abs(b.y - a.y)) }, styles: { color: 'rgba(245,158,11,0.12)', style: 'stroke_fill', borderColor: '#F59E0B', borderSize: 1 }, ignoreEvent: true }] : []
  },
}
export const PATTERN_GROUP = 'tsp-pattern'
export function buildPatternOverlays(bars: ChartBar[], hit: PatternHit, precision = 2) {
  const byDate = new Map(bars.map(bar => [bar.date.replace('T', ' ').slice(0, 16), bar]))
  const bar = (date: string) => byDate.get(date.replace('T', ' ').slice(0, 16))
  const geometry = hit.geometry
  let incomplete = !geometry
  const overlays: OverlayCreate[] = []
  const color = '#F59E0B'
  if (geometry) {
    for (const path of geometry.paths) for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1], b = path.points[i]
      const start = bar(a.date), end = bar(b.date)
      if (!start || !end || !Number.isFinite(a.price) || !Number.isFinite(b.price)) { incomplete = true; continue }
      overlays.push({ name: chanlunTemplate.name, points: [{ timestamp: start.timestamp, value: a.price }, { timestamp: end.timestamp, value: b.price }], extendData: { kind: 'stroke', color, confirmed: hit.status === 'confirmed' } })
    }
    for (const zone of geometry.zones) {
      const start = bar(zone.start), end = bar(zone.end)
      if (!start || !end) { incomplete = true; continue }
      overlays.push({ name: patternZoneTemplate.name, points: [{ timestamp: start.timestamp, value: zone.upper }, { timestamp: end.timestamp, value: zone.lower }], extendData: { kind: 'center', color, confirmed: hit.status === 'confirmed' } })
    }
    if (!geometry.paths.length && !geometry.zones.length) {
      for (const candle of bars.filter(item => item.date >= geometry.start.slice(0,16) && item.date <= geometry.end.slice(0,16))) overlays.push({ name: patternZoneTemplate.name, points: [{ timestamp: candle.timestamp, value: candle.high }, { timestamp: candle.timestamp, value: candle.low }] })
    }
    if (!bar(geometry.start) || !bar(geometry.end)) incomplete = true
    overlays.push(...buildAnnotations(bars, [], [{ start: geometry.start.slice(0,16), end: geometry.end.slice(0,16), label: hit.name, color: 'rgba(245,158,11,0.08)' }], [], null, null, color))
  }
  overlays.push(...buildAnnotations(bars, [{ date: hit.date.slice(0,16), kind: 'neutral', label: hit.status === 'confirmed' ? '形态确认' : '形态观察', color }], [], [
    { value: hit.triggerPrice, label: '触发价' }, { value: hit.stopPrice, label: '失效价' }, { value: hit.targetPrice, label: '测量目标' },
  ].flatMap(item => item.value != null && Number.isFinite(item.value) && item.value > 0 ? [{ value: item.value, label: `${item.label} ${item.value.toFixed(precision)}`, color }] : []), null, null, color))
  return { overlays: overlays.map(item => ({ ...item, groupId: PATTERN_GROUP, lock: true })), incomplete }
}
