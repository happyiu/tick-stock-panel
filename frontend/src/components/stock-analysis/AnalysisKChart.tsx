import { useMemo } from 'react'
import { useTheme } from '@/lib/theme'
import { KLineCandlestick } from '../KLineCandlestick'
import type { KlineRow, LevelSeries, LevelType, PriceLevel } from '@/lib/api'
import { LevelOverview, PriceLevelControls, usePriceLevels } from './PriceLevels'
export { LEVEL_GROUPS } from './PriceLevels'
export type { LevelType, PriceLevel } from '@/lib/api'

// ===== 预留:标记 / 区间(后续新闻面、事件区间用) =====
export interface ChartMarker {
  date: string
  label?: string
  color?: string
  above?: boolean
}
export interface ChartRange {
  start: string
  end: string
  label?: string
  color?: string
}

interface Props {
  rows: KlineRow[]
  symbol?: string
  levels?: Record<LevelType, PriceLevel[]>
  /** 带状曲线指标(布林带/Keltner/ATR)的每日序列 —— 画成跟随时间漂移的曲线 */
  series?: LevelSeries
  /** series 数据对应的日期数组(与 series 各数组对齐) */
  seriesDates?: string[]
  /** 默认开启的价位组 */
  defaultLevelTypes?: LevelType[]
  /** 预留:新闻/暴雷/利好日期标记 */
  markers?: ChartMarker[]
  /** 预留:事件区间高亮 */
  ranges?: ChartRange[]
  /** 预留:点击某根 K 线 */
  onDateClick?: (date: string) => void
  height?: number
  className?: string
  assetType?: string
}

export function AnalysisKChart({
  rows, symbol,
  levels,
  series,
  seriesDates,
  defaultLevelTypes = ['sr', 'pivot', 'keltner_s'],
  markers,
  ranges,
  onDateClick,
  height = 460,
  className,
  assetType,
}: Props) {
  useTheme()
  const state = usePriceLevels({ rows, levels, series, seriesDates, defaultLevelTypes, assetType })
  const chartMarkers = useMemo(() => markers?.map(marker => ({ ...marker, kind: 'neutral' as const, above: marker.above ?? true })), [markers])
  return (
    <div className={className}>
      {levels && <PriceLevelControls levels={levels} {...state} />}
      <KLineCandlestick
        data={state.data} symbol={symbol} height={height} assetType={assetType}
        showMA={false} showInfoBar={false} visibleBars={120} activeIndicators={['vol']}
        volumeCompare={{ enabled: false, days: 1 }} markers={chartMarkers} ranges={ranges}
        priceLines={state.priceLines} priceCurves={state.priceCurves} priceLabelWidth={144}
        highlightedKey={state.hoveredKey} onHighlightChange={state.setHoveredKey}
        onDateClick={onDateClick} showRangeSelector
      />
      {levels && <LevelOverview
        levels={levels} {...state} close={rows.at(-1)?.close} assetType={assetType}
        onHover={state.setHoveredKey}
      />}
    </div>
  )
}
