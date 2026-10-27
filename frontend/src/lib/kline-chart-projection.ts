import type { OverlayCreate, OverlayFigure, OverlayTemplate } from 'klinecharts'
import type { ChanlunProjection } from './chanlun'
import type { ChartBar } from './kline-chart'
import { fmtAssetPrice } from './format'
import { chartTheme, type Theme } from './theme'

export const PROJECTION_GROUP = 'tsp-projection'
export const projectionWidth = (width: number) => Math.min(220, Math.max(120, width * 0.32), width * 0.48)
interface ProjectionAnnotation {
  projection: ChanlunProjection
  theme: Theme
  assetType?: string
  selected: number | null
}

export const projectionTemplate: OverlayTemplate<ProjectionAnnotation> = {
  name: 'TSP_PROJECTION', totalStep: 1,
  needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createXAxisFigures: ({ overlay, bounding }) => {
    const width = projectionWidth(bounding.width), left = bounding.width - width
    const ct = chartTheme(overlay.extendData.theme)
    return [
      { type: 'rect', attrs: { x: left, y: 0, width, height: bounding.height }, styles: { color: overlay.extendData.theme === 'light' ? '#F3F2FA' : '#172133', style: 'fill' }, ignoreEvent: true },
      { type: 'text', attrs: { x: left + 6, y: bounding.height / 2, text: '条件示意区 · 无时间刻度', baseline: 'middle' }, styles: { color: ct.text, size: width < 155 ? 8 : 9, backgroundColor: 'transparent', borderSize: 0 }, ignoreEvent: true },
    ]
  },
  createPointFigures: ({ overlay, coordinates, bounding }) => {
    if (!coordinates.length || bounding.height < 100) return []
    const { projection: p, theme, assetType, selected } = overlay.extendData
    const ct = chartTheme(theme), width = projectionWidth(bounding.width), left = bounding.width - width
    const right = bounding.width - 12, top = 70, bottom = bounding.height - 30
    if (bottom <= top) return []
    const clamp = (y: number) => Math.max(top, Math.min(bottom, y))
    const price = (value: number) => fmtAssetPrice(value, assetType)
    const text = (value: string, x: number, y: number, color = ct.text, size = 10, key?: string): OverlayFigure => ({
      type: 'text', key, attrs: { x, y, text: value, baseline: 'middle' },
      styles: { color, size, backgroundColor: 'transparent', borderSize: 0 },
    })
    const figures: OverlayFigure[] = [
      { type: 'rect', attrs: { x: left, y: 0, width, height: bounding.height }, styles: { color: theme === 'light' ? '#F3F2FA' : '#172133', style: 'fill' } },
      { type: 'line', attrs: { coordinates: [{ x: left, y: 0 }, { x: left, y: bounding.height }] }, styles: { color: ct.border, size: 1 } },
      text('条件推演 ›', left + 8, 14, ct.textStrong, 11),
      text('条件示意 · 非目标价', left + 6, bounding.height - 10, ct.text, 9),
    ]
    if (bounding.height < 180) return [...figures, text('增高主图查看路径', left + 6, bounding.height / 2)]
    if (!p.center) return [...figures, text('此处尚无有效中枢', left + 6, bounding.height / 2)]
    figures.push(text(`上沿 ${price(p.center.zg)}`, left + 8, 34, '#A78BFA'), text(`下沿 ${price(p.center.zd)}`, left + 8, 50, '#A78BFA'))
    p.zones.forEach((zone, i) => {
      const upper = clamp(coordinates[1 + i * 2].y), lower = clamp(coordinates[2 + i * 2].y)
      const current = zone.kind === 'current', color = current ? '#A78BFA' : ct.text
      figures.push({ type: 'rect', attrs: { x: left + 3, y: upper, width: width - 6, height: Math.max(1, lower - upper) }, styles: { color: current ? '#8B5CF620' : '#64748B16', style: 'fill' }, ignoreEvent: true })
      for (const y of new Set([upper, lower])) figures.push({ type: 'line', attrs: { coordinates: [{ x: left + 3, y }, { x: right + 8, y }] }, styles: { color, size: 0.8, style: 'dashed', dashedValue: [4, 3] }, ignoreEvent: true })
    })
    // 分支终点为示意排版坐标，不生成未来价格或交易日。
    const start = { x: left + 7, y: clamp(coordinates[0].y) }
    const targets = { upper: top + 12, lower: bottom - 8, middle: (top + bottom) / 2 }
    const colors = theme === 'light' ? ['#B83A59', '#168060', '#7850AD'] : ['#F19CB1', '#64D2AF', '#C4ACF3']
    const used: number[] = []
    p.branches.forEach((branch, i) => {
      let y = targets[branch.target]
      if (used.some(previous => Math.abs(previous - y) < 24)) y = clamp(y + (branch.target === 'lower' ? -32 : 32))
      used.push(y)
      const key = `branch-${branch.id}`, color = colors[i], endX = right - 5
      const middleX = start.x + (endX - start.x) * 0.5
      const path = branch.target === 'middle'
        ? [start, { x: middleX - 8, y: y - 8 }, { x: middleX + 8, y: y + 8 }, { x: endX, y }]
        : [start, { x: middleX, y: start.y + (y - start.y) * 0.35 }, { x: endX, y }]
      figures.push(
        { type: 'line', key, attrs: { coordinates: path }, styles: { color, size: selected === branch.id ? 2.5 : 1.3, style: 'dashed', dashedValue: [4, 3] } },
        { type: 'circle', key, attrs: { x: endX, y, r: 8 }, styles: { color: theme === 'light' ? '#F3F2FA' : '#172133', style: 'stroke_fill', borderColor: color, borderSize: 1 } },
        text(String(branch.id), endX - 3, y, color, 10, key),
        text(branch.label, left + 9, clamp(y + (branch.target === 'lower' ? -16 : 16)), color, width < 155 ? 9 : 10, key),
      )
    })
    return figures
  },
}

export function buildProjectionOverlay(bars: ChartBar[], projection: ChanlunProjection | null | undefined, theme: Theme,
  assetType: string | undefined, selected: number | null, onSelect: (id: number) => void): OverlayCreate[] {
  if (projection?.version !== 1 || projection.ruleSource !== 'project' || !projection.anchor) return []
  const anchor = bars.find(bar => bar.date === projection.anchor!.date)
  if (!anchor || anchor !== bars.at(-1)) return []
  const values = [projection.anchor.price, ...projection.zones.flatMap(zone => [zone.zg, zone.zd])]
  if (!values.every(value => Number.isFinite(value) && value > 0)) return []
  return [{
    id: PROJECTION_GROUP, groupId: PROJECTION_GROUP, name: projectionTemplate.name, paneId: 'candle_pane',
    points: values.map(value => ({ timestamp: anchor.timestamp, value })),
    extendData: { projection, theme, assetType, selected }, lock: true, zLevel: 100,
    onRightClick: event => event.preventDefault?.(),
    onClick: event => {
      const id = Number(event.figure?.key?.replace('branch-', ''))
      if (projection.branches.some(branch => branch.id === id)) onSelect(id)
    },
  }]
}
