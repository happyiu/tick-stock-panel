import type { OverlayCreate, OverlayFigure, OverlayTemplate } from 'klinecharts'
import type { ChanlunAnalysis } from './chanlun'
import type { StockPreviewChanlunOverlayConfig } from './storage'
import { COLORS, type ChartBar } from './kline-chart'

interface StructureAnnotation {
  kind: 'stroke' | 'segment' | 'center' | 'fractal' | 'candidate' | 'divergence' | 'trend' | 'extension' | 'comparison'
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
    if (a.kind === 'trend') {
      if (coordinates.length < 4 || coordinates.length % 2) return []
      const half = coordinates.length / 2, upper = coordinates.slice(0, half), lower = coordinates.slice(half)
      const last = upper.at(-1)!, opposite = lower[0]
      return [
        { type: 'polygon', attrs: { coordinates }, styles: { color: `${a.color}18`, style: 'fill' }, ignoreEvent: true },
        ...[upper, lower].map(line => ({ type: 'line', attrs: { coordinates: line }, styles: { color: `${a.color}70`, size: 1, style: a.confirmed ? 'solid' : 'dashed', dashedValue: [4, 3] }, ignoreEvent: true })),
        ...(upper.some(p => p.x >= 0) && upper.some(p => p.x <= bounding.width) ? [{ type: 'text', attrs: { x: Math.max(45, Math.min(bounding.width - 45, last.x)), y: Math.max(12, Math.min(bounding.height - 12, (last.y + opposite.y) / 2)), text: a.label ?? '', align: 'center', baseline: 'middle' }, styles: { color: a.color, size: 10, backgroundColor: 'transparent', borderSize: 0 } }] : []),
      ]
    }
    if (a.kind === 'extension' || a.kind === 'comparison') {
      if (!end) return []
      const figures: OverlayFigure[] = [{ type: 'line', attrs: { coordinates: [point, end] }, styles: { color: a.color, size: 1, style: 'dashed', dashedValue: a.kind === 'extension' ? [5, 4] : [2, 3] } }]
      if (a.label) figures.push({ type: 'text', attrs: { x: Math.min(bounding.width - 4, end.x), y: Math.max(12, Math.min(bounding.height - 12, end.y + (a.above ? -9 : 9))), text: a.label, align: 'right', baseline: 'middle' }, styles: { color: a.color, size: 9, backgroundColor: 'transparent', borderSize: 0 } })
      return figures
    }
    if (a.kind === 'stroke' || a.kind === 'segment') {
      return end ? [{ type: 'line', attrs: { coordinates: [point, end] }, styles: {
        color: a.color, size: a.kind === 'segment' ? 2.4 : 1.4,
        style: a.confirmed ? 'solid' : 'dashed', dashedValue: [4, 3],
      }, ignoreEvent: a.kind !== 'segment' }] : []
    }
    if (a.kind === 'center') {
      if (!end) return []
      return [
        { type: 'rect', attrs: { x: Math.min(point.x, end.x), y: Math.min(point.y, end.y), width: Math.abs(end.x - point.x), height: Math.abs(end.y - point.y) },
          styles: { color: 'rgba(139,92,246,0.10)', style: 'stroke_fill', borderColor: 'rgba(139,92,246,0.50)', borderSize: 1, borderStyle: a.confirmed === false ? 'dashed' : 'solid', borderDashedValue: [4, 3] }, ignoreEvent: true },
        { type: 'text', attrs: { x: (point.x + end.x) / 2, y: Math.min(point.y, end.y) + 4, text: '中枢', align: 'center', baseline: 'top' }, styles: { color: '#A78BFA', size: 9, backgroundColor: 'transparent', borderSize: 0 }, ignoreEvent: true },
      ]
    }
    // 历史窗口外的标记不挤到可见区边缘；密集时失效背驰仅保留菱形和悬停详情。
    if (point.x < 0 || point.x > bounding.width) return []
    const direction = a.above ? -1 : 1
    const y = Math.max(8, Math.min(bounding.height - 8, point.y + direction * (a.kind === 'divergence' ? 28 : 10)))
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
    if (a.label && (!compact || a.kind === 'candidate' || (a.kind === 'divergence' && !a.invalidated))) figures.push({
      type: 'text', attrs: { x: a.kind === 'divergence' ? Math.max(40, Math.min(bounding.width - 40, point.x)) : point.x, y: Math.max(14, Math.min(bounding.height - 14, y + direction * 14)), text: a.label, align: 'center', baseline: 'middle' },
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
  const add = (id: string, dates: string[], prices: number[], annotation: StructureAnnotation, clickDate?: string) => {
    if (dates.some(date => !byDate.has(date)) || prices.some(price => !Number.isFinite(price))) return
    overlays.push({
      id: `${CHANLUN_GROUP}-${id}`, name: chanlunTemplate.name, groupId: CHANLUN_GROUP, paneId: 'candle_pane',
      points: dates.map((date, i) => ({ timestamp: byDate.get(date)!.timestamp, value: prices[i] })),
      extendData: annotation, lock: true, zLevel: annotation.kind === 'trend' ? -3 : annotation.kind === 'center' ? -2 : annotation.kind === 'extension' ? -1 : annotation.kind === 'segment' ? 9 : 8,
      onRightClick: event => event.preventDefault?.(),
      onMouseEnter: () => onTooltip(annotation.tooltip ?? null), onMouseLeave: () => onTooltip(null),
      onClick: () => onDateClick?.(clickDate ?? dates.at(-1)!),
    })
  }
  const timing = (structure: string, available: string) => hideDates ? '' : `\n结构发生：${structure}\n最早可知：${available}`
  if (config.trends && analysis.capabilities?.trends) for (const trend of analysis.trends ?? []) {
    if (trend.ruleSource !== 'project' || !trend.band.length) continue
    const label = `${trend.direction === 'up' ? '上行趋势' : trend.direction === 'down' ? '下行趋势' : '盘整'}${trend.current ? ' · 当前' : ''}`
    const upper = trend.band, lower = [...upper].reverse()
    add(`trend-${trend.id}`, [...upper.map(p => p.date), ...lower.map(p => p.date)], [...upper.map(p => p.upper), ...lower.map(p => p.lower)], {
      kind: 'trend', label, color: trend.direction === 'up' ? COLORS.bull : trend.direction === 'down' ? COLORS.bear : '#D97706', confirmed: !trend.current,
      tooltip: `${label} · 中枢位置近似（本项目规则）\n包含 ${trend.centerIds.length} 个笔中枢${timing(trend.startDate, trend.availableDate)}`,
    }, trend.availableDate)
  }
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
  if (config.segments && analysis.capabilities?.segmentRuleSource === 'project') for (const segment of analysis.segments ?? []) {
    if (segment.ruleSource !== 'project' || segment.rule !== 'feature-sequence-v1') continue
    const available = segment.confirmedAt || segment.observedAt || segment.endDate
    add(`segment-${segment.id}`, [segment.startDate, segment.endDate], [segment.startPrice, segment.endPrice], {
      kind: 'segment', color: '#60A5FA', confirmed: segment.confirmed,
      tooltip: `线段 · ${segment.confirmed ? '已确认' : '未完成'} · ${segment.componentCount} 笔\n本项目特征序列推导${segment.confirmation?.hasGap ? '；缺口已获反向特征分型验证' : ''}${timing(segment.endDate, available)}`,
    }, available)
  }
  if (config.centers) for (const center of analysis.centers ?? []) {
    add(`center-${center.id}`, [center.startDate, center.endDate], [center.zd, center.zg], { kind: 'center', color: '#A78BFA', confirmed: center.confirmed })
  }
  if (config.centerExtensions && analysis.capabilities?.centerExtensions) for (const extension of analysis.centerExtensions ?? []) {
    if (extension.ruleSource !== 'project') continue
    const values = extension.zd === extension.zg ? [['中枢边界', extension.zd] as const] : [['中枢上沿', extension.zg] as const, ['中枢下沿', extension.zd] as const]
    for (const [label, value] of values) add(`extension-${extension.id}-${label}`, [extension.startDate, extension.endDate], [value, value], {
      kind: 'extension', color: '#A78BFA99', label: extension.latest ? label : undefined, above: label !== '中枢下沿',
      tooltip: `${label}延长线：${value}\n仅作中枢价格参考，延长至已闭合观察边界${timing(extension.startDate, extension.availableDate)}`,
    }, extension.availableDate)
  }
  if (config.divergences && analysis.capabilities?.divergences) for (const divergence of analysis.divergences ?? []) {
    if (divergence.kind !== 'macd' || divergence.ruleSource !== 'czsc' || divergence.rule?.function !== 'tas_macd_bc_V230804'
      || !divergence.availableDate || !divergence.structureDate || divergence.price == null || !['candidate', 'invalidated'].includes(divergence.status)) continue
    const invalidated = divergence.status === 'invalidated'
    const label = `${divergence.direction === 'up' ? '顶背驰观察' : '底背驰观察'}${invalidated ? '失效' : ''}`
    const color = invalidated ? textColor : '#F59E0B'
    const tooltip = `${label} · 官方MACD黄白线条件\n${divergence.rule.function} ${JSON.stringify(divergence.rule.params)}\n${divergence.rawSignal?.value ?? ''}${timing(divergence.structureDate, divergence.availableDate)}\n${divergence.evidence}${invalidated && !hideDates ? `\n失效时间：${divergence.invalidatedAt}` : ''}`
    for (const [i, reference] of (divergence.references ?? []).entries()) add(`divergence-link-${divergence.id}-${i}`, [reference.endDate, divergence.structureDate], [reference.endPrice, divergence.price], {
      kind: 'comparison', color, tooltip,
    }, divergence.availableDate)
    add(`divergence-${divergence.id}`, [divergence.availableDate], [divergence.price], {
      kind: 'divergence', label, color, above: divergence.direction === 'up', invalidated, tooltip,
    })
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
