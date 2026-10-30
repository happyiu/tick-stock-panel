import { registerOverlay, type Chart, type Overlay, type OverlayTemplate, type Point } from 'klinecharts'

export const MEASUREMENT_NAME = 'TSP_MEASUREMENT'

export function measurePoints(points: Array<Partial<Point>>) {
  const [a, b] = points
  if (!a || !b || ![a.value, b.value, a.timestamp, b.timestamp, a.dataIndex, b.dataIndex].every(Number.isFinite) || a.value! <= 0 || b.value! <= 0) return null
  const [start, end] = a.timestamp! <= b.timestamp! ? [a, b] : [b, a]
  const difference = end.value! - start.value!
  return {
    difference, percent: difference / start.value! * 100,
    bars: Math.abs(b.dataIndex! - a.dataIndex!) + 1,
    days: Math.max(1, Math.round(Math.abs(b.timestamp! - a.timestamp!) / 86400000)),
  }
}

export function snapMeasurement(chart: Chart, overlay: Pick<Overlay, 'name' | 'mode' | 'points'>) {
  if (overlay.name !== MEASUREMENT_NAME || overlay.mode === 'normal') return
  const bars = chart.getDataList()
  for (const point of overlay.points) {
    const index = point.timestamp != null ? bars.findIndex(bar => bar.timestamp === point.timestamp) : point.dataIndex
    const bar = index != null ? bars[index] : undefined
    if (bar) { point.value = bar.close; point.timestamp = bar.timestamp; point.dataIndex = index }
  }
}

export const measurementTemplate: OverlayTemplate = {
  name: MEASUREMENT_NAME, totalStep: 3,
  needDefaultPointFigure: true, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ chart, overlay, coordinates, bounding }) => {
    const [a, b] = coordinates
    if (!a || !b) return []
    const bars = chart.getDataList()
    const points = overlay.points.map(point => ({ ...point, dataIndex: point.timestamp != null ? bars.findIndex(bar => bar.timestamp === point.timestamp) : point.dataIndex }))
    if (points.some(point => point.dataIndex == null || point.dataIndex < 0 || point.dataIndex >= bars.length)) return []
    const result = measurePoints(points)
    if (!result) return []
    const color = result.difference >= 0 ? '#EF4444' : '#26A69A'
    const signed = (value: number, precision: number) => `${value > 0 ? '+' : ''}${value.toFixed(precision)}`
    const label = `${signed(result.percent, 2)}%  ${signed(result.difference, chart.getSymbol()?.pricePrecision ?? 2)}  ${result.bars}根  ${result.days}天`
    return [
      { type: 'rect', attrs: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(1, Math.abs(b.x - a.x)), height: Math.max(1, Math.abs(b.y - a.y)) }, styles: { color: `${color}20`, style: 'fill' } },
      { type: 'line', attrs: { coordinates: [a, b] }, styles: { color, size: 1.4, style: 'dashed', dashedValue: [4, 3] } },
      { type: 'text', attrs: { x: Math.max(4, Math.min(Math.min(a.x, b.x), bounding.width - label.length * 7 - 16)), y: Math.max(4, Math.min(a.y, b.y) - 28), text: label, align: 'left', baseline: 'top' }, styles: { color: '#FFFFFF', backgroundColor: color, size: 12, paddingLeft: 8, paddingRight: 8, paddingTop: 5, paddingBottom: 5, borderRadius: 12 } },
    ]
  },
}
registerOverlay(measurementTemplate)
