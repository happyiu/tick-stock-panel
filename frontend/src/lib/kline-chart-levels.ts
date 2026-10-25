import type { OverlayCreate, OverlayTemplate } from 'klinecharts'
import { fmtAssetPrice } from './format'
import type { ChartBar, ChartPriceCurve, ChartPriceLine, ChartPriceZone } from './kline-chart'

interface LevelAnnotation {
  color: string
  label: string
  dashed: boolean
  highlighted: boolean
  dimmed: boolean
  labelWidth: number
  curve: boolean
  breaks: number[]
  anchored?: boolean
  zone?: boolean
}

export const LEVEL_GROUP = 'tsp-levels'
export const levelTemplate: OverlayTemplate<LevelAnnotation> = {
  name: 'TSP_PRICE_LEVEL', totalStep: 1,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ chart, overlay, coordinates, bounding }) => {
    const data = overlay.extendData
    if (!coordinates.length) return []
    const { color, label, highlighted, dimmed, dashed, labelWidth, curve, breaks } = data
    const edge = bounding.width - Math.min(labelWidth, bounding.width * 0.4)
    const end = coordinates.at(-1)!
    const styles = { color, size: highlighted ? 2 : 1, style: dashed ? 'dashed' : 'solid', dashedValue: [4, 3] }
    const lines = curve ? coordinates.slice(1).flatMap((point, i) => breaks.includes(i + 1) ? [] : [{
      type: 'line', attrs: { coordinates: [coordinates[i], point] }, styles,
    }]) : data.anchored && coordinates[0].x > edge ? [] : [{
      type: 'line', attrs: { coordinates: [{ x: data.anchored ? Math.max(0, coordinates[0].x) : 0, y: end.y }, { x: edge, y: end.y }] }, styles,
    }]
    // 低透明度用 alpha 色表达，图形库的 line/text 样式没有 opacity 字段。
    const fade = (value: string) => {
      if (!/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) return value
      const alpha = value.length === 9 ? parseInt(value.slice(7), 16) : 255
      return `${value.slice(0, 7)}${Math.round(alpha * (dimmed ? 0.12 : highlighted ? 1 : 0.7)).toString(16).padStart(2, '0')}`
    }
    if (data.zone) {
      const left = Math.max(0, coordinates[0].x)
      const top = Math.max(0, Math.min(coordinates[0].y, end.y))
      const bottom = Math.min(bounding.height, Math.max(coordinates[0].y, end.y))
      if (left >= bounding.width || top >= bottom) return []
      const y = (top+bottom)/2
      return [
        { type: 'rect', attrs: { x: left, y: top, width: bounding.width-left, height: bottom-top },
          styles: { color: `${color}${dimmed ? '04' : highlighted ? '30' : '18'}`, style: 'stroke_fill', borderColor: fade(color), borderSize: highlighted ? 2 : 1 } },
        { type: 'text', attrs: { x: bounding.width-4, y, text: label, align: 'right', baseline: 'middle' },
          styles: { color: fade(color), size: highlighted ? 10 : 9, family: 'JetBrains Mono, monospace', backgroundColor: chart.getStyles().separator.color } },
      ]
    }
    return [
      ...lines.map(line => ({ ...line, styles: { ...line.styles, color: fade(color) } })),
      ...(label && end.y >= 0 && end.y <= bounding.height ? [{
        type: 'text', attrs: { x: labelWidth ? edge + 6 : bounding.width - 4, y: end.y, text: label, align: labelWidth ? 'left' : 'right', baseline: 'middle' },
        styles: { color: fade(color), size: highlighted ? 10 : 9, family: 'JetBrains Mono, monospace', weight: highlighted ? 'bold' : 'normal', backgroundColor: chart.getStyles().separator.color, borderSize: 0, paddingLeft: 3, paddingRight: 3 },
      }] : []),
    ]
  },
}

export function buildLevelOverlays(
  bars: ChartBar[], lines: ChartPriceLine[], curves: ChartPriceCurve[], labelWidth: number,
  highlightedKey: string | null | undefined, onHighlightChange: ((key: string | null) => void) | undefined,
  assetType?: string, zones: ChartPriceZone[] = [],
): OverlayCreate[] {
  const byDate = new Map(bars.map(bar => [bar.date, bar]))
  const overlays: OverlayCreate[] = []
  const add = (id: string, key: string, color: string, label: string, points: OverlayCreate['points'], curve: boolean, dashed: boolean, breaks: number[] = [], anchored = false, zone = false) => {
    if (!points?.length) return
    overlays.push({
      id: `${LEVEL_GROUP}-${id}`, name: levelTemplate.name, groupId: LEVEL_GROUP, paneId: 'candle_pane',
      points, lock: true, zLevel: highlightedKey === key ? 20 : 0, fixedZLevel: true,
      extendData: { color, label, curve, dashed, breaks, labelWidth, anchored, zone, highlighted: highlightedKey === key, dimmed: highlightedKey != null && highlightedKey !== key } satisfies LevelAnnotation,
      onMouseEnter: () => onHighlightChange?.(key), onMouseLeave: () => onHighlightChange?.(null),
      onRightClick: event => event.preventDefault?.(),
    })
  }
  for (const zone of zones) {
    if (!Number.isFinite(zone.lower) || !Number.isFinite(zone.upper) || zone.lower <= 0 || zone.upper <= zone.lower) continue
    const start = byDate.get(zone.start) ?? bars.find(bar => bar.date >= zone.start)
    if (!start) continue
    add(`zone-${zone.key}`, zone.key, zone.color,
      `${zone.label} ${fmtAssetPrice(zone.lower, assetType)}–${fmtAssetPrice(zone.upper, assetType)}`,
      [{ timestamp: start.timestamp, value: zone.lower }, { timestamp: start.timestamp, value: zone.upper }], false, false, [], true, true)
  }
  if (bars.length) for (const [i, line] of lines.entries()) {
    if (!line.key || !Number.isFinite(line.value) || line.value <= 0) continue
    const start = line.start ? (byDate.get(line.start) ?? bars.find(bar => bar.date >= line.start!)) : undefined
    if (line.start && !start) continue
    add(`line-${line.key}-${i}`, line.key, line.color ?? '#71717A', `${line.label ?? ''} ${fmtAssetPrice(line.value, assetType)}`.trim(),
      [{ value: line.value, ...(start ? { timestamp: start.timestamp } : {}) }], false, true, [], !!start)
  }
  for (const [i, curve] of curves.entries()) {
    const points: NonNullable<OverlayCreate['points']> = [], breaks: number[] = []
    let gap = false
    for (const row of curve.data) {
      const bar = byDate.get(row.date)
      if (!bar || row.value == null || !Number.isFinite(row.value)) { gap = true; continue }
      if (gap) breaks.push(points.length)
      points.push({ timestamp: bar.timestamp, value: row.value }); gap = false
    }
    const latest = points.at(-1)?.value
    add(`curve-${i}`, curve.key, curve.color, latest == null ? '' : fmtAssetPrice(latest, assetType), points, true, curve.dashed !== false, breaks)
  }
  return overlays
}
