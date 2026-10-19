import type { IndicatorTemplate, IndicatorDrawCallback, IndicatorFigure } from 'klinecharts'
import type { ChartIndicatorResult, ChartIndicatorDrawing } from './api'
import { chartTheme, getTheme } from './theme'
import { chartIndicators } from './kline-chart'

type Row = Record<string, number | null>
export interface FormulaContext { packet: Omit<ChartIndicatorResult, 'rows' | 'dates'>; values: Record<string, Row>; volumeCompare: boolean; compareDays: number; key: string }
const lightColors: Record<string, string> = { '#FF0000': '#DC2626', '#00FF00': '#15803D', '#FFFF00': '#A16207', '#FFFFFF': '#374151', '#FF00FF': '#C026D3', '#00FFFF': '#0E7490', '#CC66FF': '#8B5CF6', '#669900': '#4D7C0F' }
export const formulaColor = (color: string, light?: string) => getTheme() === 'light' ? light ?? lightColors[color] ?? color : color
const field = (drawing: ChartIndicatorDrawing, index: number) => drawing.fields.find(f => f[0] === index)?.[1] ?? ''
const text = (drawing: ChartIndicatorDrawing, index: number) => drawing.text.find(f => f[0] === index)?.[1] ?? ''
const num = (drawing: ChartIndicatorDrawing, index: number, row?: Row | null) => drawing.constants?.find(f => f[0] === index)?.[1] ?? row?.[field(drawing, index)] ?? null
const enabled = (value: number | null) => value != null && Number.isFinite(value) && value !== 0
const signalIcon = (packet: Pick<ChartIndicatorResult, 'pane' | 'drawings'>, drawing: ChartIndicatorDrawing, row?: Row | null) => {
  if (packet.pane !== 'main' || drawing.kind !== 'DRAWTEXT') return undefined
  const label = text(drawing, 2), iconType = label === '进攻' ? 1 : label === '撤退' ? 2 : null
  return iconType == null ? undefined : packet.drawings.find(d => d.kind === 'DRAWICON' && num(d, 2, row) === iconType
    && field(d, 0) === field(drawing, 0) && num(d, 0, row) === num(drawing, 0, row))
}
const SIGNAL_ARROW_OFFSET = 8

export function serverFormulaFigures(packet: ChartIndicatorResult): IndicatorFigure<Row>[] {
  const lines: IndicatorFigure<Row>[] = packet.figures.filter(f => !f.hidden).map(f => ({ key: f.key, title: `${f.key}: `, type: 'line',
    styles: () => ({ color: formulaColor(f.color, f.light_color), size: f.width, style: f.dash ? 'dashed' : 'solid', dashedValue: [f.dash_size ?? 4, f.dash_size ?? 3] }) }))
  for (const drawing of packet.drawings.filter(d => d.kind === 'DRAWICON' || d.kind === 'DRAWTEXT')) {
    lines.push({ key: drawing.key, type: drawing.kind === 'DRAWICON' ? 'polygon' : 'text',
      attrs: ({ coordinate, data }) => {
        const { x, [drawing.key]: y } = coordinate.current
        if (packet.pane === 'main' && drawing.kind === 'DRAWTEXT') {
          const label = text(drawing, 2), iconType = label === '进攻' ? 1 : label === '撤退' ? 2 : null
          const icon = signalIcon(packet, drawing, data.current)
          const arrowY = icon ? coordinate.current[icon.key] : undefined
          // 以箭头的屏幕坐标定位文字, 避免价轴缩放拉大两者距离。
          if (arrowY != null && Number.isFinite(arrowY)) return {
            x, y: arrowY + (iconType === 1 ? 1 : -1) * (SIGNAL_ARROW_OFFSET + 9), text: label, align: 'center', baseline: iconType === 1 ? 'top' : 'bottom',
          }
        }
        const down = num(drawing, 2, data.current) === 2
        const direction = down ? -1 : 1
        const side = num(drawing, 3, data.current) ?? 4
        const paired = drawing.kind === 'DRAWICON' && packet.drawings.some(d => signalIcon(packet, d, data.current)?.key === drawing.key)
        const iconY = paired ? y + direction * SIGNAL_ARROW_OFFSET : y
        return drawing.kind === 'DRAWICON' ? { coordinates: [{ x, y: iconY - direction*5 }, { x: x-4, y: iconY+direction*side }, { x: x+4, y: iconY+direction*side }] }
          : { x, y, text: packet.pane === 'main' ? text(drawing, 2) : '', baseline: 'middle' }
      }, styles: () => ({ color: formulaColor(drawing.color, drawing.light_color), style: 'fill', size: 11, family: 'JetBrains Mono, monospace' }) })
  }
  return lines
}

export const serverFormulaDraw: IndicatorDrawCallback<Row, number, FormulaContext> = args => {
  const { ctx, chart, indicator, xAxis, yAxis, bounding } = args
  const context = indicator.extendData
  if (!context) return false
  const { packet } = context
  const range = chart.getVisibleRange()
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, bounding.width, bounding.height); ctx.clip()
  const labels: { x: number; y: number; value: string; color: string; align: CanvasTextAlign }[] = []
  const occupied: { left: number; right: number; top: number; bottom: number }[] = []
  const segment = (x1: number, y1: number, x2: number, y2: number, color: string, dashed: boolean, dashSize?: number) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dashed ? [dashSize ?? 4, dashSize ?? 3] : [])
    ctx.beginPath(); ctx.moveTo(x1, yAxis.convertToPixel(y1)); ctx.lineTo(x2, yAxis.convertToPixel(y2)); ctx.stroke()
  }
  for (const drawing of packet.drawings.filter(d => d.kind === 'HLINE')) {
    const color = formulaColor(drawing.color, drawing.light_color), value = num(drawing, 0, indicator.result[Math.max(0, range.from)])
    if (value == null) continue
    segment(0, value, bounding.width, value, color, drawing.dash, drawing.dash_size)
    const label = text(drawing, 1)
    if (label) { ctx.font = '9px JetBrains Mono, monospace'; ctx.fillStyle = color; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(label, bounding.width-4, yAxis.convertToPixel(value)-2) }
  }
  const drawings = packet.drawings.filter(d => !['HLINE','TOOLTIP','DRAWICON'].includes(d.kind) && !(d.kind === 'DRAWTEXT' && packet.pane === 'main'))
  const starts = new Map<string, number>()
  const begin = drawings.some(d => d.kind === 'DRAWLINE') ? 0 : Math.max(0, range.from)
  for (let i = begin; i < Math.min(range.to, indicator.result.length); i++) {
    const row = indicator.result[i], x = xAxis.convertToPixel(i)
    for (const drawing of drawings) {
      const color = formulaColor(drawing.color, drawing.light_color), active = enabled(num(drawing, 0, row))
      if (drawing.kind === 'DRAWLINE') {
        if (active) starts.set(drawing.key, i)
        const lineStart = starts.get(drawing.key)
        if (i >= range.from && lineStart != null && enabled(num(drawing, 2, row))) {
          const start = num(drawing, 1, indicator.result[lineStart]), end = num(drawing, 3, row)
          if (start != null && end != null) segment(xAxis.convertToPixel(lineStart), start, x, end, color, drawing.dash, drawing.dash_size)
        }
        continue
      }
      if (i < range.from || !active) continue
      if (drawing.kind === 'STICKLINE') {
        const from = num(drawing, 1, row), to = num(drawing, 2, row), width = num(drawing, 3, row)
        if (from == null || to == null || width == null || from === to) continue
        const space = chart.getBarSpace(), y1 = yAxis.convertToPixel(from), y2 = yAxis.convertToPixel(to)
        const barWidth = context.key === 'vol' ? Math.min(space.bar*width/4, space.gapBar) : space.bar*width/4
        ctx.fillStyle = color; ctx.strokeStyle = color
        const params = [x-barWidth/2, Math.min(y1,y2), barWidth, Math.abs(y2-y1)] as const
        if (enabled(num(drawing, 4, row))) ctx.strokeRect(...params)
        else ctx.fillRect(...params)
      } else if (drawing.kind === 'DRAWTEXT') {
        const value = num(drawing, 1, row)
        if (value != null) labels.push({ x, y: yAxis.convertToPixel(value), value: text(drawing, 2), color, align: num(drawing, 3, row) === 1 ? 'right' : 'left' })
      } else if (drawing.kind === 'DRAWSEGMENT') {
        const start = num(drawing, 1, row), to = num(drawing, 2, row)
        const from = start != null ? num(drawing, 2, indicator.result[start]) : null
        if (start != null && from != null && to != null) segment(xAxis.convertToPixel(start), from, x, to, color, drawing.dash, drawing.dash_size)
      }
    }
  }
  ctx.font = '11px JetBrains Mono, monospace'; ctx.textBaseline = 'middle'
  // Match existing signal label collision behavior: evaluate labels bar by bar.
  labels.sort((a,b) => a.x-b.x)
  for (const label of labels) {
    const width = ctx.measureText(label.value).width, left = label.align === 'right' ? label.x-width : label.x
    const box = { left, right: left+width, top: label.y-6, bottom: label.y+6 }
    if (box.left < 0 || box.right > bounding.width || occupied.some(other => box.left < other.right+2 && box.right+2 > other.left && box.top < other.bottom && box.bottom > other.top)) continue
    occupied.push(box); ctx.fillStyle = label.color; ctx.textAlign = label.align; ctx.fillText(label.value, label.x, label.y)
  }
  ctx.restore()
  if (context.key === 'vol') {
    const draw = chartIndicators.find(i => i.name === 'TSP_VOL')?.draw
    draw?.({ ...args, indicator: { ...indicator, extendData: context.volumeCompare, calcParams: [context.compareDays] } } as unknown as Parameters<NonNullable<typeof draw>>[0])
  }
  return false
}

export function serverFormulaTemplate(name: string): IndicatorTemplate<Row, number, FormulaContext> {
  return { name, series: 'normal', calc: (data, indicator) => data.map(bar => {
    const context = indicator.extendData
    const values = context?.values[String(bar.date)] ?? {}
    return { ...values, ...Object.fromEntries((context?.packet.drawings ?? []).filter(d => ['DRAWICON','DRAWTEXT'].includes(d.kind))
      .map(d => {
        const icon = d.kind === 'DRAWTEXT' ? signalIcon(context!.packet, d, values)
          : context?.packet.drawings.some(label => signalIcon(context.packet, label, values)?.key === d.key) ? d : undefined
        // 仅改变显示锚点，避免公式中的百分比文字/箭头坐标撑大价格轴。
        const anchor = icon ? (num(icon, 2, values) === 1 ? bar.low : bar.high) : num(d, 1, values)
        return [d.key, enabled(num(d,0,values)) ? anchor : null]
      })) }
  }), shouldUpdate: () => ({ calc: true, draw: true }), draw: serverFormulaDraw,
  createTooltipDataSource: ({ indicator, chart, crosshair }) => {
    const context = indicator.extendData as FormulaContext | undefined
    if (!context) return { name: '', calcParamsText: '', legends: [], features: [] }
    const index = crosshair.dataIndex ?? chart.getDataList().length-1, row = indicator.result[index]
    if (context.key === 'vol') {
      const create = chartIndicators.find(i => i.name === 'TSP_VOL')?.createTooltipDataSource
      if (create) {
        // The native tooltip reads one index; avoid rebuilding every historical bar on mousemove.
        const bars = chart.getDataList()
        const values = new Array<(typeof bars)[number]>(bars.length)
        values[index] = { ...bars[index], ...row, volume: bars[index]?.volume }
        const chartWithValues = { ...chart, getDataList: () => values }
        return create({ indicator: { ...indicator, extendData: context.volumeCompare, calcParams: [context.compareDays] }, chart: chartWithValues, crosshair } as unknown as Parameters<typeof create>[0])
      }
    }
    if (context.packet.pane === 'main') return { name: '', calcParamsText: '', legends: [], features: [] }
    const tips = context.packet.drawings.filter(d => d.kind === 'TOOLTIP')
    const legends = tips.length ? tips.map(d => {
      const value = num(d,0,row), digits = Math.min(8, Math.max(0, num(d,2,row) ?? 2))
      return { title: { text: `${text(d,1)}: `, color: d.color === '#808080' ? formulaTextColor() : formulaColor(d.color, d.light_color) }, value: { text: value == null ? '—' : `${value.toFixed(digits)}${text(d,3)}`, color: d.color === '#808080' ? formulaTextColor() : formulaColor(d.color, d.light_color) } }
    }) : context.packet.figures.filter(f => !f.hidden).map(f => ({ title: { text: `${f.key}: `, color: formulaColor(f.color, f.light_color) }, value: { text: row?.[f.key] == null ? '—' : row[f.key]!.toFixed(2), color: formulaColor(f.color, f.light_color) } }))
    if (context.key === 'bull-bear-trend-v2') legends.push({ title: { text: '信号状态: ', color: formulaTextColor() }, value: { text: !row ? '—' : !row.supported ? '仅30分钟/日线' : !row.ready ? '需81根K线' : '已就绪', color: formulaTextColor() } })
    return { name: context.packet.name, calcParamsText: '', legends, features: [] }
  } }
}

export const formulaContext = (key: string, result: ChartIndicatorResult, volumeCompare: boolean, compareDays: number): FormulaContext => {
  const { rows, dates, ...packet } = result
  return { key, packet, volumeCompare, compareDays, values: Object.fromEntries(dates.map((date, i) => [date, rows[i]])) }
}
export const formulaTextColor = () => chartTheme(getTheme()).text
