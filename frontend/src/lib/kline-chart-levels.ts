import type { OverlayCreate, OverlayTemplate } from 'klinecharts'
import { fmtAssetPrice } from './format'
import type { ChartBar, ChartPriceCurve, ChartPriceLine } from './kline-chart'

interface LevelAnnotation {
  color: string
  label: string
  dashed: boolean
  highlighted: boolean
  dimmed: boolean
  labelWidth: number
  curve: boolean
  breaks: number[]
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
    }]) : [{ type: 'line', attrs: { coordinates: [{ x: 0, y: end.y }, { x: edge, y: end.y }] }, styles }]
    // 低透明度用 alpha 色表达，图形库的 line/text 样式没有 opacity 字段。
    const fade = (value: string) => {
      if (!/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) return value
      const alpha = value.length === 9 ? parseInt(value.slice(7), 16) : 255
      return `${value.slice(0, 7)}${Math.round(alpha * (dimmed ? 0.12 : highlighted ? 1 : 0.7)).toString(16).padStart(2, '0')}`
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
  assetType?: string,
): OverlayCreate[] {
  const byDate = new Map(bars.map(bar => [bar.date, bar]))
  const overlays: OverlayCreate[] = []
  const add = (id: string, key: string, color: string, label: string, points: OverlayCreate['points'], curve: boolean, dashed: boolean, breaks: number[] = []) => {
    if (!points?.length) return
    overlays.push({
      id: `${LEVEL_GROUP}-${id}`, name: levelTemplate.name, groupId: LEVEL_GROUP, paneId: 'candle_pane',
      points, lock: true, zLevel: highlightedKey === key ? 20 : 0, fixedZLevel: true,
      extendData: { color, label, curve, dashed, breaks, labelWidth, highlighted: highlightedKey === key, dimmed: highlightedKey != null && highlightedKey !== key } satisfies LevelAnnotation,
      onMouseEnter: () => onHighlightChange?.(key), onMouseLeave: () => onHighlightChange?.(null),
      onRightClick: event => event.preventDefault?.(),
    })
  }
  if (bars.length) for (const [i, line] of lines.entries()) {
    if (!line.key || !Number.isFinite(line.value) || line.value <= 0) continue
    add(`line-${line.key}-${i}`, line.key, line.color ?? '#71717A', `${line.label ?? ''} ${fmtAssetPrice(line.value, assetType)}`.trim(), [{ value: line.value }], false, true)
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
