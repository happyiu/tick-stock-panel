/** 历史导入路径兼容；所有 K 线均由 KLineChart 绘制。 */
export { KLineCandlestick as EChartsCandlestick } from './KLineCandlestick'
export { SUB_CHARTS, OVERLAY_INDICATORS } from '@/lib/kline-chart'
export type { CandlestickProps, OHLC, ChartMarker, ChartRange, ChartPriceLine, StockInfo, VolumeCompareConfig } from '@/lib/kline-chart'
import { SUB_CHARTS } from '@/lib/kline-chart'
export const INDICATORS = SUB_CHARTS.filter(chart => chart.key !== 'vol')
