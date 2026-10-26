import type { OverlayCreate, OverlayFigure, OverlayTemplate } from 'klinecharts'
import type { ChanlunAnalysis } from './chanlun'
import type { StockPreviewChanlunOverlayConfig } from './storage'
import { COLORS, type ChartBar } from './kline-chart'

interface StructureAnnotation {
  kind: 'stroke' | 'segment' | 'center' | 'fractal' | 'candidate' | 'divergence'
  color: string
  label?: string
  above?: boolean
  confirmed?: boolean
  invalidated?: boolean
  tooltip?: string
}

export const CHANLUN_GROUP = 'tsp-chanlun'
export const chanlunTemplate: OverlayTemplate<StructureAnnotation> = {
  name: 'TSP_CHANLUN', totalStep: 1,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ chart, overlay, coordinates, bounding }) => {
    const [point, end] = coordinates
    if (!point) return []
    const a = overlay.extendData
    const compact = chart.getVisibleRange().to - chart.getVisibleRange().from > 60
    if (a.kind === 'stroke' || a.kind === 'segment') {
      return end ? [{ type: 'line', attrs: { coordinates: [point, end] }, styles: {
        color: a.color, size: a.kind === 'segment' ? 2.4 : 1.4,
        style: a.confirmed ? 'solid' : 'dashed', dashedValue: [4, 3],
      }, ignoreEvent: true }] : []
    }
    if (a.kind === 'center') {
      if (!end) return []
      return [
        { type: 'rect', attrs: { x: Math.min(point.x, end.x), y: Math.min(point.y, end.y), width: Math.abs(end.x - point.x), height: Math.abs(end.y - point.y) },
          styles: { color: 'rgba(139,92,246,0.10)', style: 'stroke_fill', borderColor: 'rgba(139,92,246,0.50)', borderSize: 1, borderStyle: a.confirmed === false ? 'dashed' : 'solid', borderDashedValue: [4, 3] }, ignoreEvent: true },
        { type: 'text', attrs: { x: (point.x + end.x) / 2, y: Math.min(point.y, end.y) + 4, text: '中枢', align: 'center', baseline: 'top' }, styles: { color: '#A78BFA', size: 9, backgroundColor: 'transparent', borderSize: 0 }, ignoreEvent: true },
      ]
    }
    const direction = a.above ? -1 : 1
    const y = Math.max(8, Math.min(bounding.height - 8, point.y + direction * 10))
    const size = compact ? 3 : 5
    const figures: OverlayFigure[] = []
    if (a.kind === 'candidate') {
      figures.push({ type: 'circle', attrs: { x: point.x, y, r: a.invalidated ? 3.5 : 4.5 }, styles: { color: a.color, style: 'fill' } })
    } else {
      const shape = a.kind === 'divergence'
        ? [{ x: point.x, y: y - size }, { x: point.x + size, y }, { x: point.x, y: y + size }, { x: point.x - size, y }]
        : [{ x: point.x, y: y - direction * size }, { x: point.x - size, y: y + direction * size }, { x: point.x + size, y: y + direction * size }]
      figures.push({ type: 'polygon', attrs: { coordinates: shape }, styles: { color: a.color, style: 'fill' } })
    }
    if (a.label && (!compact || a.kind === 'candidate')) figures.push({
      type: 'text', attrs: { x: point.x, y: Math.max(14, Math.min(bounding.height - 14, y + direction * 14)), text: a.label, align: 'center', baseline: 'middle' },
      styles: { color: a.color, size: compact ? 8 : 9, family: 'JetBrains Mono, monospace', backgroundColor: 'transparent', borderSize: 0 },
    })
    return figures
  },
}

/** 只投影现有结构分析结果；候选点按最早可知日期定位，不提前放到结构发生日。 */
export function buildChanlunOverlays(
  bars: ChartBar[], analysis: ChanlunAnalysis | undefined, config: StockPreviewChanlunOverlayConfig | undefined,
  textColor: string, hideDates: boolean, onTooltip: (text: string | null) => void,
  onDateClick?: (date: string) => void,
): OverlayCreate[] {
  if (!analysis || !config?.enabled) return []
  const byDate = new Map(bars.map(bar => [bar.date, bar]))
  for (const bar of bars) if (typeof bar.periodEnd === 'string') byDate.set(bar.periodEnd, bar)
  const overlays: OverlayCreate[] = []
  const add = (id: string, dates: string[], prices: number[], annotation: StructureAnnotation) => {
    if (dates.some(date => !byDate.has(date)) || prices.some(price => !Number.isFinite(price))) return
    overlays.push({
      id: `${CHANLUN_GROUP}-${id}`, name: chanlunTemplate.name, groupId: CHANLUN_GROUP, paneId: 'candle_pane',
      points: dates.map((date, i) => ({ timestamp: byDate.get(date)!.timestamp, value: prices[i] })),
      extendData: annotation, lock: true, zLevel: annotation.kind === 'center' ? -2 : 8,
      onRightClick: event => event.preventDefault?.(),
      onMouseEnter: () => onTooltip(annotation.tooltip ?? null), onMouseLeave: () => onTooltip(null),
      onClick: () => onDateClick?.(dates.at(-1)!),
    })
  }
  const timing = (structure: string, available: string) => hideDates ? '' : `\n结构发生：${structure}\n最早可知：${available}`
  if (config.fractals) for (const [i, fractal] of (analysis.fractals ?? []).entries()) {
    const bottom = fractal.type === 'bottom'
    add(`fractal-${i}`, [fractal.date], [fractal.price], {
      kind: 'fractal', color: bottom ? '#60A5FA' : '#A78BFA', label: bottom ? '底' : '顶', above: !bottom,
      tooltip: `${bottom ? '底' : '顶'}分型${timing(fractal.date, fractal.confirmedAt)}`,
    })
  }
  if (config.strokes) for (const structure of analysis.strokes ?? []) {
    add(`stroke-${structure.id}`, [structure.startDate, structure.endDate], [structure.startPrice, structure.endPrice], {
      kind: 'stroke', color: structure.direction === 'up' ? COLORS.bull : COLORS.bear, confirmed: structure.confirmed,
    })
  }
  if (config.centers) for (const center of analysis.centers ?? []) {
    add(`center-${center.id}`, [center.startDate, center.endDate], [center.zd, center.zg], { kind: 'center', color: '#A78BFA', confirmed: center.confirmed })
  }
  if (config.candidates) for (const signal of analysis.candidateSignals ?? []) {
    if (signal.status !== 'candidate' && signal.status !== 'invalidated') continue
    const labels = { first_buy: 'B1', second_buy: 'B2', third_buy: 'B3', first_sell: 'S1', second_sell: 'S2', third_sell: 'S3' }
    const buy = signal.kind.endsWith('_buy'), invalidated = signal.status === 'invalidated'
    const label = `${labels[signal.kind]}${invalidated ? '失效' : '候选'}`
    add(`candidate-${signal.id}`, [signal.availableDate], [signal.price], {
      kind: 'candidate', label, above: !buy, invalidated,
      color: invalidated ? textColor : buy ? COLORS.bull : COLORS.bear,
      tooltip: `${label}${signal.rule ? ` · ${signal.rule.function}` : ''}${timing(signal.structureDate, signal.availableDate)}\n失效边界：${signal.boundary}（本项目规则）`,
    })
  }
  return overlays
}
