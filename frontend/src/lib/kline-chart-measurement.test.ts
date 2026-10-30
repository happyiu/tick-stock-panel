// @vitest-environment jsdom

import { expect, it } from 'vitest'
import type { Chart, Overlay } from 'klinecharts'
import { MEASUREMENT_NAME, measurePoints, snapMeasurement } from './kline-chart-measurement'
const points = [
  { timestamp: 1790000000000, dataIndex: 10, value: 1.5 },
  { timestamp: 1790000000000 + 58 * 86400000, dataIndex: 46, value: 1.3 },
]
it('日期先后决定涨跌，根数含两端，天数按时间差', () => {
  expect(measurePoints(points)).toEqual({ difference: 1.3 - 1.5, percent: (1.3 - 1.5) / 1.5 * 100, bars: 37, days: 58 })
  expect(measurePoints([...points].reverse())).toEqual(measurePoints(points))
  const rising = [{ ...points[0], value: 1.3 }, { ...points[1], value: 1.5 }]
  expect(measurePoints(rising)?.percent).toBeCloseTo((1.5 - 1.3) / 1.3 * 100)
  expect(measurePoints([...rising].reverse())).toEqual(measurePoints(rising))
  expect(measurePoints([points[0], points[0]])).toEqual({ difference: 0, percent: 0, bars: 1, days: 1 })
  expect(measurePoints([])).toBeNull()
  expect(measurePoints([{ ...points[0], value: 0 }, points[1]])).toBeNull()
  expect(measurePoints([{ ...points[0], value: NaN }, points[1]])).toBeNull()
})
it('仅开启吸附的测量取收盘价', () => {
  const chart = { getDataList: () => [{ timestamp: points[0].timestamp, close: 1.42 }] } as unknown as Chart
  const overlay = { name: MEASUREMENT_NAME, mode: 'normal', points: [{ ...points[0] }] } as Overlay
  snapMeasurement(chart, overlay)
  expect(overlay.points[0].value).toBe(1.5)
  overlay.mode = 'strong_magnet'
  snapMeasurement(chart, overlay)
  expect(overlay.points[0]).toMatchObject({ value: 1.42, dataIndex: 0 })
  overlay.name = 'segment'; overlay.points[0].value = 1.6
  snapMeasurement(chart, overlay)
  expect(overlay.points[0].value).toBe(1.6)
})
