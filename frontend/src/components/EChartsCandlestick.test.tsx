// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
vi.mock('echarts', () => { throw new Error('K线不应加载ECharts') })
import { EChartsCandlestick, SUB_CHARTS, INDICATORS } from './EChartsCandlestick'
import { KLineCandlestick } from './KLineCandlestick'
it('历史导入路径兼容新引擎，指标元数据不再加载ECharts', () => {
  expect(EChartsCandlestick).toBe(KLineCandlestick)
  expect(SUB_CHARTS).toHaveLength(8)
  expect(INDICATORS.every(indicator => indicator.key !== 'vol')).toBe(true)
})
