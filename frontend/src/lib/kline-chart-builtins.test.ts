// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { getSupportedIndicators, getSupportedOverlays } from 'klinecharts'
import { BUILTIN_INDICATORS, BUILTIN_MAIN_INDICATORS, BUILTIN_SUB_INDICATORS } from './kline-chart-builtins'
import { DRAWING_TOOLS } from '@/components/ChartDrawingToolbar'
import { OVERLAY_INDICATORS, SUB_CHARTS, toChartBars } from './kline-chart'

it('所有新增工具和指标确实存在于锁定的KLineChart版本，主副图无重复', () => {
  expect(BUILTIN_INDICATORS).toHaveLength(20)
  for (const indicator of BUILTIN_INDICATORS) expect(getSupportedIndicators()).toContain(indicator.name)
  for (const tool of DRAWING_TOOLS) expect(getSupportedOverlays()).toContain(tool.name)
  expect(new Set([...OVERLAY_INDICATORS, ...SUB_CHARTS].map(item => item.key)).size).toBe(OVERLAY_INDICATORS.length + SUB_CHARTS.length)
  for (const indicator of BUILTIN_MAIN_INDICATORS) expect(OVERLAY_INDICATORS).toContainEqual(indicator)
  for (const indicator of BUILTIN_SUB_INDICATORS) expect(SUB_CHARTS).toContainEqual(indicator)
  expect(BUILTIN_INDICATORS.some(indicator => ['MACD', 'RSI', 'KDJ', 'VOL', 'MA', 'BOLL', 'AVP'].includes(indicator.name))).toBe(false)
})

it('内置指标消费已有OHLCV，保持成交量单位和成交额映射', () => {
  const bars = toChartBars([{ date: '2026-10-16', open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 1000, amount: 110000 }], 1)
  expect(bars[0]).toMatchObject({ volume: 1000, source_volume: 1000, turnover: 110000 })
})
