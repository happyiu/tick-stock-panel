import type { IndicatorDrawCallback, IndicatorFigure, IndicatorTemplate, KLineData } from 'klinecharts'
import { ANGEL_DEVIL_MA, calculateAngelDevil } from './angelDevil'
import { BOLL2_LINES, calculateBoll2 } from './boll2'
import { calculateKdDivergence } from './kdDivergence'
import { calculateKdEnhanced } from './kdEnhanced'
import { calculateEtfSwingV2 } from './etfSwingV2'
import { calculateBullBearTrendV2 } from './bullBearTrendV2'
import { chartTheme, getTheme } from './theme'

export type FormulaRow = Record<string, number | null>
interface FormulaContext { period: string }
type FormulaIndicator = IndicatorTemplate<FormulaRow, number, FormulaContext>
type Draw = IndicatorDrawCallback<FormulaRow, number, FormulaContext>
type PaletteKey = keyof ReturnType<typeof palette>

const palette = () => {
  const light = getTheme() === 'light'
  return {
    red: light ? '#DC2626' : '#FF0000', green: light ? '#15803D' : '#00FF00',
    yellow: light ? '#A16207' : '#FFFF00', white: light ? '#374151' : '#FFFFFF',
    magenta: light ? '#C026D3' : '#FF00FF', cyan: light ? '#0E7490' : '#00FFFF',
    pink: light ? '#8B5CF6' : '#CC66FF', olive: light ? '#4D7C0F' : '#669900', gray: '#808080',
  }
}
const themeColor = (dark: string, light: string) => getTheme() === 'light' ? light : dark
const emptyTooltip = () => ({ name: '', calcParamsText: '', features: [], legends: [] })
// 原生量柱缺量时画零；公式仍需区分缺失量与真实零量。
const volumeBars = (data: KLineData[]) => data.map(bar => ({ ...bar,
  volume: 'source_volume' in bar ? bar.source_volume as number | undefined : bar.volume,
}))
const numeric = (rows: object[]): FormulaRow[] => rows.map(row => Object.fromEntries(
  Object.entries(row).filter(([, value]) => value === null || typeof value === 'number' || typeof value === 'boolean')
    .map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value]),
))
const line = (key: string, color: () => string, size = 1): IndicatorFigure<FormulaRow> => ({
  key, type: 'line', styles: () => ({ color: color(), size }),
})

interface Signal {
  field: string
  key?: string
  text: string
  y: number | null
  color: PaletteKey
  arrow?: boolean
  down?: boolean
  align?: CanvasTextAlign
}
const kdSignals = (enhanced: boolean): Signal[] => [
  { field: 'lowCross', text: '金叉', y: 12, color: 'red', arrow: true },
  { field: 'highCross', text: '死叉', y: 88, color: 'green', arrow: true, down: true },
  { field: 'bottomDivergence', text: enhanced ? '底背离' : '加仓', y: enhanced ? 18 : null, color: 'red' },
  { field: 'topDivergence', text: enhanced ? '顶背离' : '减仓', y: enhanced ? 82 : null, color: 'green' },
  { field: 'buy', text: enhanced ? '超卖金叉' : '买', y: 30, color: 'red' },
  { field: 'sell', text: enhanced ? '超买死叉' : '卖', y: 70, color: 'green' },
  ...(enhanced ? [
    { field: 'trial', text: '试仓', y: 40, color: 'yellow' as const },
    { field: 'reduce', text: '减仓', y: 60, color: 'green' as const },
  ] : []),
]
const etfSignals: Signal[] = [
  { field: 'bottomSignal', text: '底部观察', y: 8, color: 'yellow', align: 'right' },
  { field: 'buySignal', text: '试仓', y: 20, color: 'red', align: 'right' },
  { field: 'addSignal', text: '加仓', y: 35, color: 'magenta', align: 'right' },
  { field: 'topSignal', text: '高位观察', y: 90, color: 'cyan', align: 'right' },
  { field: 'sellSignal', text: '减仓', y: 78, color: 'green', align: 'right' },
  { field: 'exitSignal', text: '退出预警', y: 96, color: 'white', align: 'right' },
]
const bullSignals: (Signal & { from: number; to: number; width: number })[] = [
  { field: 'bottomSignal', text: '底观', from: 0, to: 12, width: 2, y: 14, color: 'cyan', align: 'right' },
  { field: 'trySignal', text: '试仓', from: 0, to: 30, width: 3, y: 32, color: 'red', align: 'right' },
  { field: 'addSignal', text: '加仓', from: 0, to: 50, width: 3, y: 52, color: 'magenta', align: 'right' },
  { field: 'topSignal', text: '高观', from: 88, to: 100, width: 1, y: 84, color: 'yellow', align: 'right' },
  { field: 'reduceSignal', text: '减仓', from: 70, to: 100, width: 3, y: 66, color: 'green', align: 'right' },
  { field: 'exitSignal', text: '退出', from: 0, to: 100, width: 1, y: 91, color: 'white', align: 'right' },
]

function signalFigures(signals: Signal[], nativeText = false): IndicatorFigure<FormulaRow>[] {
  return signals.map(signal => {
    const key = signal.key ?? `${signal.field}Mark`
    return {
      key, type: signal.arrow ? 'polygon' : 'text',
      attrs: ({ coordinate }) => {
        const { x, [key]: y } = coordinate.current
        const direction = signal.down ? -1 : 1
        return signal.arrow ? { coordinates: [
          { x, y: y - direction * 5 }, { x: x - 4, y: y + direction * 4 }, { x: x + 4, y: y + direction * 4 },
        ] } : { x, y: nativeText ? y + direction * 9 : y, text: nativeText ? signal.text : '', align: nativeText ? 'center' : signal.align ?? 'left', baseline: nativeText ? signal.down ? 'bottom' : 'top' : 'middle' }
      },
      styles: () => ({ color: palette()[signal.color], size: 11, style: 'fill', family: 'JetBrains Mono, monospace' }),
    }
  })
}

function withSignals(rows: FormulaRow[], signals: Signal[]) {
  return rows.map(row => ({ ...row, ...Object.fromEntries(signals.map(signal => [
    `${signal.field}Mark`, row[signal.field] ? signal.y ?? (row.d == null ? null : row.d - 5) : null,
  ])) }))
}

/** 绘制的柱线保留公式的上下端，不转换为从零起画的普通柱。只遍历可见区间。 */
function subDraw(kind: 'kd' | 'enhanced' | 'etf' | 'bull'): Draw {
  return ({ ctx, chart, indicator, xAxis, yAxis, bounding }) => {
    const colors = palette()
    const range = chart.getVisibleRange()
    ctx.save()
    ctx.beginPath(); ctx.rect(0, 0, bounding.width, bounding.height); ctx.clip()
    const segment = (x1: number, from: number, x2: number, to: number, color: string, dash: number[] = []) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dash)
      ctx.beginPath(); ctx.moveTo(x1, yAxis.convertToPixel(from)); ctx.lineTo(x2, yAxis.convertToPixel(to)); ctx.stroke()
    }
    const references: [number, string, string?][] = kind === 'kd' || kind === 'enhanced'
      ? [[90, colors.green, '逃顶线 90'], [50, colors.red, '中轴线 50'], [10, colors.yellow, '抄底线 10']]
      : kind === 'etf' ? [[20, colors.olive], [50, colors.gray], [80, colors.red]]
        : [[80, colors.gray], [50, colors.gray], [20, colors.gray]]
    ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'
    for (const [value, color, label] of references) {
      segment(0, value, bounding.width, value, color, kind === 'etf' ? [2, 2] : kind === 'bull' ? [4, 3] : [])
      if (label) { ctx.fillStyle = color; ctx.fillText(label, bounding.width - 4, yAxis.convertToPixel(value) - 2) }
    }
    const barSpace = chart.getBarSpace().bar
    const signals = kind === 'kd' || kind === 'enhanced' ? kdSignals(kind === 'enhanced') : kind === 'etf' ? etfSignals : bullSignals
    const labels: { x: number; y: number; text: string; color: string; align: CanvasTextAlign }[] = []
    for (let i = Math.max(0, range.from); i < Math.min(range.to, indicator.result.length); i++) {
      const row = indicator.result[i], x = xAxis.convertToPixel(i)
      const stick = (from: number | null, to: number | null, width: number, color: string) => {
        if (from == null || to == null || from === to) return
        const y1 = yAxis.convertToPixel(from), y2 = yAxis.convertToPixel(to)
        ctx.fillStyle = color
        ctx.fillRect(x - barSpace * width / 8, Math.min(y1, y2), barSpace * width / 4, Math.abs(y2 - y1))
      }
      if (kind === 'kd' || kind === 'enhanced') {
        stick(row.k, row.d, kind === 'enhanced' ? 2 : 2.5, row.k! > row.d! ? colors.red : colors.green)
        if (kind === 'kd') {
          if (row.buy) stick(3, 20, 8, colors.red)
          if (row.sell) stick(85, 70, 8, colors.green)
          for (const [field, color] of [['bottomLineStart', colors.red], ['topLineStart', colors.green]] as const) {
            const start = row[field]
            const from = start == null ? null : indicator.result[start]?.d
            if (start != null && from != null && row.d != null) segment(xAxis.convertToPixel(start), from, x, row.d, color)
          }
        }
      } else if (kind === 'etf') stick(0, row.k, 1.8, row.kUp ? colors.pink : colors.olive)
      else for (const signal of bullSignals) {
        if (row[signal.field]) stick(signal.from, signal.to, signal.width, colors[signal.color])
      }
      for (const signal of signals) {
        const value = row[`${signal.field}Mark`]
        if (!signal.arrow && value != null) labels.push({ x, y: yAxis.convertToPixel(value), text: signal.text, color: colors[signal.color], align: signal.align ?? 'left' })
      }
    }
    ctx.font = '11px JetBrains Mono, monospace'; ctx.textBaseline = 'middle'
    const occupied: { left: number; right: number; top: number; bottom: number }[] = []
    for (const label of labels) {
      const width = ctx.measureText(label.text).width
      const left = label.align === 'right' ? label.x - width : label.x
      const box = { left, right: left + width, top: label.y - 6, bottom: label.y + 6 }
      if (box.left < 0 || box.right > bounding.width || occupied.some(other =>
        box.left < other.right + 2 && box.right + 2 > other.left && box.top < other.bottom && box.bottom > other.top)) continue
      occupied.push(box)
      ctx.fillStyle = label.color; ctx.textAlign = label.align
      ctx.fillText(label.text, label.x, label.y)
    }
    ctx.restore()
    return false // 线条和信号标记由原生 figures 继续绘制。
  }
}

type InfoField = [string, string, PaletteKey, number?, string?]
const kdInfo: InfoField[] = [['k', 'K', 'yellow'], ['d', 'D', 'white'], ['bottomDivergence', '底背离', 'red', 0], ['topDivergence', '顶背离', 'green', 0]]
const enhancedInfo: InfoField[] = [['k', 'K', 'white'], ['d', 'D', 'yellow']]
const etfInfo: InfoField[] = [
  ['k', '趋势强度', 'white'], ['d', '慢速线', 'yellow'], ['bottomCount', '底部条件数', 'yellow', 0],
  ['topCount', '高位条件数', 'cyan', 0], ['volumeRatio', '量比参考', 'gray', 2, 'x'], ['defense', '防守参考', 'white', 3],
]
const bullInfo: InfoField[] = [
  ['dp', '多方强度', 'magenta'], ['lowPos', '低位程度', 'green'], ['rv', '相对量能', 'gray', 2, 'x'],
  ['stop', '动态防守价', 'white', 3], ['e21', '趋势参考价', 'white', 3],
]
function subTooltip(name: string, fields: InfoField[], status = false): NonNullable<FormulaIndicator['createTooltipDataSource']> {
  return ({ chart, indicator, crosshair }) => {
    const row = indicator.result[crosshair.dataIndex ?? chart.getDataList().length - 1]
    const colors = palette()
    const legends = fields.map(([field, title, color, digits = 2, suffix = '']) => ({
      title: { text: `${title}: `, color: color === 'gray' ? chartTheme(getTheme()).text : colors[color] },
      value: { text: row?.[field] == null ? '—' : `${row[field]!.toFixed(digits)}${suffix}`, color: color === 'gray' ? chartTheme(getTheme()).text : colors[color] },
    }))
    if (status) legends.push({
      title: { text: '信号状态: ', color: chartTheme(getTheme()).text },
      value: { text: !row ? '—' : !row.supported ? '仅30分钟/日线' : !row.ready ? '需81根K线' : '已就绪', color: chartTheme(getTheme()).text },
    })
    return { name, calcParamsText: '', features: [], legends }
  }
}

export const formulaIndicators: FormulaIndicator[] = [
  {
    name: 'TSP_ANGEL_DEVIL', shortName: '天使魔鬼', series: 'price', precision: 3,
    figures: [
      ...ANGEL_DEVIL_MA.map(ma => line(ma.key, () => themeColor(ma.color, ma.lightColor), ma.width)),
      ...signalFigures([
        { field: 'attack', key: 'attackText', text: '进攻', y: null, color: 'yellow' },
        { field: 'retreat', key: 'retreatText', text: '撤退', y: null, color: 'white', down: true },
      ], true),
      ...(['attackArrow', 'retreatArrow'] as const).map((key, i): IndicatorFigure<FormulaRow> => ({
        key, type: 'polygon', attrs: ({ coordinate }) => {
          const { x, [key]: y } = coordinate.current, direction = i === 0 ? 1 : -1
          return { coordinates: [{ x, y: y - direction * 5 }, { x: x - 4, y: y + direction * 5 }, { x: x + 4, y: y + direction * 5 }] }
        }, styles: () => ({ color: i === 0 ? '#FF0000' : '#00FFFF', style: 'fill' }),
      })),
    ],
    calc: data => {
      const rows = calculateAngelDevil(data.map(b => b.close))
      return numeric(rows).map((row, i) => ({ ...row,
        attackArrow: rows[i].signal === 'buy' ? data[i].low * 0.97 : null,
        attackText: rows[i].signal === 'buy' ? data[i].low * 0.97 : null,
        retreatArrow: rows[i].signal === 'sell' ? data[i].high * 1.03 : null,
        retreatText: rows[i].signal === 'sell' ? data[i].high * 1.03 : null,
      }))
    },
    createTooltipDataSource: emptyTooltip,
  },
  {
    name: 'TSP_BOLL2', shortName: 'boll2', series: 'price', precision: 3,
    figures: BOLL2_LINES.map(f => line(f.key, () => themeColor(f.color, f.lightColor))),
    calc: data => numeric(calculateBoll2(data.map(b => b.close))), createTooltipDataSource: emptyTooltip,
  },
  ...([false, true] as const).map((enhanced): FormulaIndicator => ({
    name: enhanced ? 'TSP_KD_ENHANCED' : 'TSP_KD_DIVERGENCE', shortName: enhanced ? 'K/D精准背离增强版' : 'KD背离',
    series: 'normal', precision: 2, minValue: enhanced ? 0 : -10, maxValue: enhanced ? 100 : 110,
    figures: [
      line('k', () => enhanced ? palette().white : palette().yellow, enhanced ? 2 : 1),
      line('d', () => enhanced ? palette().yellow : themeColor('#FFFFFF', '#2563EB')),
      ...(!enhanced ? [line('bottomDivergence', () => palette().red), line('topDivergence', () => palette().green)] : []),
      ...signalFigures(kdSignals(enhanced)),
    ],
    calc: data => withSignals(numeric(enhanced ? calculateKdEnhanced(data) : calculateKdDivergence(data)), kdSignals(enhanced)),
    draw: subDraw(enhanced ? 'enhanced' : 'kd'),
    createTooltipDataSource: subTooltip(enhanced ? 'K/D精准背离增强版' : 'KD背离', enhanced ? enhancedInfo : kdInfo),
  })),
  {
    name: 'TSP_ETF_SWING_V2', shortName: 'ETF波段操盘V2', series: 'normal', precision: 2, minValue: 0, maxValue: 105,
    figures: [line('k', () => palette().white, 2), line('d', () => palette().yellow), ...signalFigures(etfSignals)],
    calc: data => withSignals(numeric(calculateEtfSwingV2(volumeBars(data))), etfSignals), draw: subDraw('etf'),
    createTooltipDataSource: subTooltip('ETF波段操盘V2', etfInfo),
  },
  {
    name: 'TSP_BULL_BEAR_TREND_V2', shortName: '多空趋势V2', series: 'normal', precision: 2, minValue: 0, maxValue: 100,
    figures: [line('dp', () => palette().magenta, 2), line('lowPos', () => palette().green, 2), ...signalFigures(bullSignals)],
    calc: (data, indicator) => withSignals(numeric(calculateBullBearTrendV2(volumeBars(data), indicator.extendData?.period ?? '1d')), bullSignals),
    // 默认更新检测只因 calcParams 变化重算，不会因 extendData.period 变化重算。
    shouldUpdate: (previous, current) => ({ calc: previous.extendData?.period !== current.extendData?.period, draw: true }),
    draw: subDraw('bull'), createTooltipDataSource: subTooltip('多空趋势V2', bullInfo, true),
  },
]

export const formulaName = (key: string) => `TSP_${key.toUpperCase().replaceAll('-', '_')}`

/** 按实际可用宽度预留提示换行空间，避免辅助价格遮住副图。 */
export function formulaHeaderHeight(key: string, width: number) {
  if (key !== 'etf-swing-v2' && key !== 'bull-bear-trend-v2') return 28
  return width < 400 ? 80 : width < 650 ? 56 : 40
}
