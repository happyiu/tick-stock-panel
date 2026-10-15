import type { OverlayCreate, OverlayTemplate, OverlayFigure } from 'klinecharts'
import { COLORS, type ChartBar, type ChartMarker, type ChartPriceLine, type ChartRange } from './kline-chart'

interface Annotation {
  kind: 'marker' | 'range' | 'price' | 'added'
  label?: string
  color: string
  above?: boolean
  arrow?: boolean
  date?: string
}

export const annotationTemplate: OverlayTemplate<Annotation> = {
  name: 'TSP_ANNOTATION', totalStep: 1,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ chart, overlay, coordinates, bounding }) => {
    const point = coordinates[0]
    if (!point) return []
    const { kind, color, label, above, arrow } = overlay.extendData
    const { x, y } = point
    const text = (tx: number, ty: number, content: string, align: CanvasTextAlign = 'center'): OverlayFigure => ({
      type: 'text', attrs: { x: tx, y: ty, text: content, align, baseline: 'bottom' },
      styles: { color: kind === 'range' ? chart.getStyles().xAxis.tickText.color : color, size: 10, family: 'JetBrains Mono, monospace', backgroundColor: chart.getStyles().separator.color },
      ignoreEvent: kind !== 'marker',
    })
    const line = (x1: number, y1: number, x2: number, y2: number): OverlayFigure => ({
      type: 'line', attrs: { coordinates: [{ x: x1, y: y1 }, { x: x2, y: y2 }] },
      styles: { color, size: 1, style: 'dashed', dashedValue: [4, 3] }, ignoreEvent: true,
    })
    if (kind === 'range') {
      const end = coordinates[1]
      if (!end) return []
      return [
        { type: 'rect', attrs: { x, y: 0, width: end.x - x, height: bounding.height }, styles: { color, style: 'fill' }, ignoreEvent: true },
        ...(label ? [text((x + end.x) / 2, 16, label)] : []),
      ]
    }
    if (kind === 'price') {
      const x1 = coordinates.length > 1 ? x : 0
      const x2 = coordinates[1]?.x ?? bounding.width
      return [line(x1, y, x2, y), ...(label ? [text(x2 - 4, y - 3, label, 'right')] : [])]
    }
    if (kind === 'added') {
      const bottom = bounding.height - 12
      return [line(x, Math.min(y, bottom - 20), x, bottom - 20), text(x, bottom, '自选')]
    }
    const range = chart.getVisibleRange()
    const compact = range.to - range.from > 60 && above && !arrow
    if (compact) return [{ type: 'circle', attrs: { x, y: y - 10, r: 2 }, styles: { color, style: 'fill' } }]
    const direction = above ? -1 : 1
    const tip = y + direction * 7
    const figures: OverlayFigure[] = []
    if (arrow) figures.push({
      type: 'polygon', attrs: { coordinates: [
        { x, y: tip }, { x: x - 5, y: tip + direction * 9 }, { x: x + 5, y: tip + direction * 9 },
      ] }, styles: { color, style: 'fill' },
    })
    if (label) figures.push(text(x, y + direction * (arrow ? 26 : 8) + (above ? 0 : 10), label))
    return figures
  },
}

export const ANNOTATION_GROUP = 'tsp-business'

export function buildAnnotations(
  bars: ChartBar[], markers: ChartMarker[], ranges: ChartRange[], priceLines: ChartPriceLine[],
  addedDate: string | null | undefined, linkedPrice: number | null | undefined,
  textColor: string, onDateClick?: (date: string) => void,
  pricePrecision = 2,
): OverlayCreate[] {
  const byDate = new Map(bars.map(bar => [bar.date, bar]))
  const annotations: OverlayCreate[] = []
  const add = (points: OverlayCreate['points'], annotation: Annotation) => annotations.push({
    name: annotationTemplate.name, groupId: ANNOTATION_GROUP, paneId: 'candle_pane',
    points, extendData: annotation, lock: true, zLevel: annotation.kind === 'range' ? -1 : 10,
    onRightClick: event => event.preventDefault?.(),
    ...(annotation.kind === 'marker' ? { onClick: () => onDateClick?.(annotation.date!) } : {}),
  })
  for (const marker of markers) {
    const bar = byDate.get(marker.date)
    if (!bar) continue
    const above = marker.above || marker.kind !== 'buy'
    add([{ timestamp: bar.timestamp, value: above ? bar.high : bar.low }], {
      kind: 'marker', date: marker.date, above, arrow: !marker.above,
      label: marker.label, color: marker.color ?? (marker.above ? '#FACC15' : marker.kind === 'buy' ? COLORS.bull : marker.kind === 'sell' ? COLORS.bear : textColor),
    })
  }
  for (const range of ranges) {
    const start = byDate.get(range.start), end = byDate.get(range.end)
    if (start && end) add([{ timestamp: start.timestamp, value: start.close }, { timestamp: end.timestamp, value: end.close }], {
      kind: 'range', label: range.label, color: range.color ?? 'rgba(59,130,246,0.08)',
    })
  }
  for (const line of [...priceLines, ...(linkedPrice != null ? [{ value: linkedPrice, label: linkedPrice.toFixed(pricePrecision), color: '#3B82F6' }] : [])]) {
    if (!Number.isFinite(line.value) || line.value <= 0) continue
    const start = line.start && byDate.get(line.start), end = line.end && byDate.get(line.end)
    add(start && end ? [{ timestamp: start.timestamp, value: line.value }, { timestamp: end.timestamp, value: line.value }] : [{ value: line.value }], {
      kind: 'price', label: line.label, color: line.color ?? textColor,
    })
  }
  const addedBar = addedDate ? bars.findLast(bar => bar.date <= addedDate) : undefined
  if (addedBar) add([{ timestamp: addedBar.timestamp, value: addedBar.low }], { kind: 'added', color: '#3B82F6' })
  return annotations
}
