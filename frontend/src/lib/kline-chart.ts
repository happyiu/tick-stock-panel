import type { IndicatorTemplate, KLineData } from 'klinecharts'
import type { ReactNode } from 'react'
import { BUILTIN_MAIN_INDICATORS, BUILTIN_SUB_INDICATORS } from './kline-chart-builtins'
import type { KlinePeriod, ChartIndicatorResult, ChartIndicatorDefinition } from './api'
import type { ChanlunAnalysis } from './chanlun'
import type { StockPreviewChanlunOverlayConfig } from './storage'

export interface OHLC {
  date: string
  open: number
  high: number
  low: number
  close: number
  periodEnd?: string | null
  isClosed?: boolean
  volume?: number
  amount?: number | null
  ma5?: number | null
  ma10?: number | null
  ma20?: number | null
  ma60?: number | null
  macd_dif?: number | null
  macd_dea?: number | null
  macd_hist?: number | null
  rsi_6?: number | null
  rsi_14?: number | null
  rsi_24?: number | null
  kdj_k?: number | null
  kdj_d?: number | null
  kdj_j?: number | null
  boll_upper?: number | null
  boll_lower?: number | null
  atr_14?: number | null
  atr14?: number | null
}

export interface ChartMarker {
  date: string
  kind: 'buy' | 'sell' | 'neutral'
  label?: string
  /** 若为 true，标记放在蜡烛上方（如涨停连板标签）。 */
  above?: boolean
  /** 自定义标签颜色，覆盖默认的 kind 对应色。 */
  color?: string
}

export interface ChartRange {
  start: string
  end: string
  label?: string
  color?: string
}

export interface ChartPriceLine {
  value: number
  label?: string
  color?: string
  start?: string
  end?: string
  key?: string
  affectScale?: boolean
}

export interface ChartPriceCurve {
  key: string
  label: string
  color: string
  dashed?: boolean
  data: { date: string; value: number | null }[]
}

export interface ChartPriceZone {
  key: string
  label: string
  lower: number
  upper: number
  start: string
  color: string
}

export interface CandlestickProps {
  indicatorDefinitions?: ChartIndicatorDefinition[]
  indicatorResults?: Record<string, ChartIndicatorResult>
  data: OHLC[]
  toolbarControls?: ReactNode
  period?: KlinePeriod
  markers?: ChartMarker[]
  ranges?: ChartRange[]
  priceLines?: ChartPriceLine[]
  priceCurves?: ChartPriceCurve[]
  priceZones?: ChartPriceZone[]
  priceLabelWidth?: number
  highlightedKey?: string | null
  onHighlightChange?: (key: string | null) => void
  showRangeSelector?: boolean
  height?: number
  showMA?: boolean
  showInfoBar?: boolean
  showMarkers?: boolean
  onToggleMarkers?: () => void
  stockInfo?: StockInfo
  symbol?: string
  linkedPrice?: number | null
  onDateClick?: (date: string) => void
  selectedDate?: string | null
  onPriceDoubleClick?: (price: number, currentPrice: number) => void
  visibleBars?: number | 'all'
  activeIndicators?: string[]
  volumeCompare?: VolumeCompareConfig
  volumeCompareControls?: ReactNode
  addedDate?: string | null
  assetType?: string
  chanlunAnalysis?: ChanlunAnalysis
  chanlunOverlay?: StockPreviewChanlunOverlayConfig
  projectionEnabled?: boolean
  projectionBranchId?: number | null
  onProjectionBranchSelect?: (id: number) => void
  chanlunError?: string
  hideCurrentDate?: boolean
}

export interface StockInfo {
  name?: string
  total_shares?: number
  float_shares?: number
  /** 扩展数据（key: configId__fieldName），来自 klineDaily 的 ext_columns */
  ext?: Record<string, unknown>
}

export interface VolumeCompareConfig {
  enabled: boolean
  days: number
}

export const COLORS = {
  bull: '#C74040', bear: '#2D9B65',
  ma5: '#A1A1AA', ma10: '#3B82F6', ma20: '#F97316', ma60: '#8B5CF6',
}

export const SUB_CHARTS = [
  { key: 'vol', label: '成交量', height: 84 },
  { key: 'macd', label: 'MACD', height: 72 },
  { key: 'rsi', label: 'RSI', height: 72 },
  { key: 'kdj', label: 'KDJ', height: 72 },
  { key: 'kd-divergence', label: 'KD背离', height: 160 },
  { key: 'kd-enhanced', label: 'K/D精准背离增强版', height: 180 },
  { key: 'etf-swing-v2', label: 'ETF波段操盘V2', height: 200 },
  { key: 'bull-bear-trend-v2', label: '多空趋势V2', height: 200 },
  ...BUILTIN_SUB_INDICATORS,
]
export const OVERLAY_INDICATORS = [
  { key: 'ma', label: 'MA 均线' },
  { key: 'angel-devil', label: '天使魔鬼' },
  { key: 'boll', label: 'BOLL' },
  { key: 'boll2', label: 'boll2' },
  ...BUILTIN_MAIN_INDICATORS,
]

export type ChartBar = KLineData & { date: string }
type IndicatorValues = Record<string, number | undefined>
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** 日期使用北京墙钟；指标只投影后端结果，避免截断历史后重新计算引入口径差异。 */
export function toChartBars(rows: OHLC[], compareDays: number): ChartBar[] {
  const byTime = new Map<number, OHLC>()
  for (const row of rows) {
    const timestamp = Date.parse(`${row.date.includes(' ') || row.date.includes('T')
      ? row.date.replace(' ', 'T') : `${row.date}T00:00:00`}+08:00`)
    if (!Number.isFinite(timestamp) || [row.open, row.high, row.low, row.close].some(v => !Number.isFinite(v))) continue
    byTime.set(timestamp, row)
  }
  const entries = [...byTime]
  if (entries.some(([time], i) => i > 0 && time < entries[i - 1][0])) entries.sort(([a], [b]) => a - b)
  const prefix = [0]
  const days = Math.max(1, Math.min(20, Math.round(compareDays) || 1))
  return entries.map(([timestamp, row], i) => {
    const volume = finite(row.volume) ?? 0
    prefix.push(prefix[i] + volume)
    const previousAverage = i >= days ? (prefix[i] - prefix[i - days]) / days : 0
    const bar: ChartBar = {
      ...row, timestamp, volume, source_volume: finite(row.volume), turnover: finite(row.amount),
      vol_ma5: i >= 4 ? (prefix[i + 1] - prefix[i - 4]) / 5 : undefined,
      vol_ma10: i >= 9 ? (prefix[i + 1] - prefix[i - 9]) / 10 : undefined,
      volume_ratio: previousAverage > 0 ? volume / previousAverage : undefined,
    }
    for (const key of Object.keys(row)) {
      if (!['date', 'periodEnd', 'isClosed'].includes(key)) bar[key] = finite(row[key as keyof OHLC])
    }
    bar.volume = volume
    return bar
  })
}

export function classifyBarUpdate(previous: ChartBar[], next: ChartBar[]): 'none' | 'tail' | 'reset' {
  if (!previous.length || !next.length || next.length < previous.length || next.length > previous.length + 1) return 'reset'
  const equal = (a: ChartBar, b: ChartBar) => {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every(key => Object.is(a[key], b[key]))
  }
  const historyLength = next.length === previous.length ? previous.length - 1 : previous.length
  for (let i = 0; i < historyLength; i++) if (!equal(previous[i], next[i])) return 'reset'
  if (next.length > previous.length) return next.at(-1)!.timestamp > previous.at(-1)!.timestamp ? 'tail' : 'reset'
  if (next.at(-1)!.timestamp !== previous.at(-1)!.timestamp) return 'reset'
  return equal(previous.at(-1)!, next.at(-1)!) ? 'none' : 'tail'
}

const line = (key: string, title: string, color: string) => ({
  key, title: `${title}: `, type: 'line', styles: () => ({ color, size: 1 }),
})

const definitions = [
  { key: 'MA', series: 'price', figures: [
    line('ma5', 'MA5', COLORS.ma5), line('ma10', 'MA10', COLORS.ma10),
    line('ma20', 'MA20', COLORS.ma20), line('ma60', 'MA60', COLORS.ma60),
  ] },
  { key: 'BOLL', series: 'price', figures: [
    line('boll_upper', 'BOLL上', '#E879F9'), line('boll_lower', 'BOLL下', '#E879F9'),
  ] },
  { key: 'VOL', series: 'volume', minValue: 0, figures: [
    { key: 'volume', title: '量: ', type: 'bar', baseValue: 0,
      styles: ({ data }: { data: { current: IndicatorValues | null } }) => ({
        color: (data.current?.volume_direction ?? 0) >= 0 ? COLORS.bull : COLORS.bear,
      }) },
    line('vol_ma5', 'VOL5', '#FACC15'), line('vol_ma10', 'VOL10', '#8B5CF6'),
  ] },
  { key: 'MACD', series: 'normal', figures: [
    line('macd_dif', 'DIF', '#FACC15'), line('macd_dea', 'DEA', '#8B5CF6'),
    { key: 'macd_hist', title: 'MACD: ', type: 'bar', baseValue: 0,
      styles: ({ data }: { data: { current: IndicatorValues | null } }) => ({
        color: (data.current?.macd_hist ?? 0) >= 0 ? COLORS.bull : COLORS.bear,
      }) },
  ] },
  { key: 'RSI', series: 'normal', minValue: 0, maxValue: 100, figures: [
    line('rsi_6', 'RSI6', '#FACC15'), line('rsi_14', 'RSI14', '#3B82F6'), line('rsi_24', 'RSI24', '#8B5CF6'),
  ] },
  { key: 'KDJ', series: 'normal', figures: [
    line('kdj_k', 'K', '#FACC15'), line('kdj_d', 'D', '#3B82F6'), line('kdj_j', 'J', '#8B5CF6'),
  ] },
] as const

export const chartIndicators: IndicatorTemplate<IndicatorValues>[] = definitions.map(def => ({
  name: `TSP_${def.key}`, shortName: def.key === 'VOL' ? '成交量' : def.key,
  series: def.series, precision: def.key === 'MACD' ? 3 : 2,
  ...('minValue' in def ? { minValue: def.minValue } : {}),
  ...('maxValue' in def ? { maxValue: def.maxValue } : {}),
  figures: [...def.figures],
  calc: data => data.map(bar => ({
    ...Object.fromEntries(def.figures.map(f => [f.key, finite(bar[f.key])])),
    ...(def.key === 'VOL' ? { volume_direction: bar.close - bar.open } : {}),
  })),
  ...(def.key === 'MA' || def.key === 'BOLL' ? {
    createTooltipDataSource: () => ({ name: '', calcParamsText: '', features: [], legends: [] }),
  } : {}),
  ...(def.key === 'VOL' ? {
    draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
      const range = chart.getVisibleRange()
      if (!indicator.extendData) return false
      ctx.save()
      ctx.font = '8px JetBrains Mono, monospace'
      ctx.fillStyle = chart.getStyles().xAxis.tickText.color
      ctx.textAlign = 'center'
      const bars = chart.getDataList()
      let labelRight = -Infinity
      for (let i = range.from; i < range.to; i++) {
        const ratio = finite(bars[i]?.volume_ratio)
        if (ratio == null) continue
        const label = `${ratio.toFixed(1)}x`
        const x = xAxis.convertToPixel(i), halfWidth = ctx.measureText(label).width / 2
        if (x - halfWidth <= labelRight + 2) continue
        ctx.fillText(label, x, yAxis.convertToPixel(bars[i].volume ?? 0) - 3)
        labelRight = x + halfWidth
      }
      ctx.restore()
      return false
    },
    createTooltipDataSource: ({ chart, indicator, crosshair }) => {
      const index = crosshair.dataIndex ?? chart.getDataList().length - 1
      const bar = chart.getDataList()[index]
      const fmt = (v: unknown) => {
        const n = finite(v)
        return n == null ? '—' : n >= 1e8 ? `${(n / 1e8).toFixed(2)}亿` : n >= 1e4 ? `${(n / 1e4).toFixed(0)}万` : n.toFixed(0)
      }
      const legends = ['volume', 'vol_ma5', 'vol_ma10'].map((key, i) => ({
        title: ['量: ', 'VOL5: ', 'VOL10: '][i], value: fmt(bar?.[key]),
      }))
      if (indicator.extendData) {
        const ratio = finite(bar?.volume_ratio)
        legends.push({ title: `量比${indicator.calcParams[0]}: `, value: ratio == null ? '—' : `${ratio.toFixed(2)}x` })
      }
      return { name: '成交量', calcParamsText: '', features: [], legends }
    },
  } : {}),
}))
