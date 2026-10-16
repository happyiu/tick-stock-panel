import { expect, it, vi } from 'vitest'
import { buildLevelOverlays, levelTemplate } from './kline-chart-levels'
import { toChartBars } from './kline-chart'
const bars = toChartBars(Array.from({ length: 4 }, (_, i) => ({ date: `2026-10-${12 + i}`, open: 10, close: 11, high: 12, low: 9 })), 1)
it('关键价位保留ETF精度和双向高亮，曲线缺失值不跨缺口连线', () => {
  const hover = vi.fn()
  const overlays = buildLevelOverlays(bars, [{ key: 'sr', value: 0.497, label: '支撑', color: '#F97316' }], [{
    key: 'boll', label: '布林', color: '#F97316', dashed: false,
    data: bars.map((bar, i) => ({ date: bar.date, value: i === 1 ? null : i + 10 })),
  }], 144, 'sr', hover, 'etf')
  expect(overlays[0].extendData).toMatchObject({ label: '支撑 0.497', highlighted: true, dimmed: false })
  expect(overlays[1].extendData).toMatchObject({ label: '13.000', breaks: [1], dashed: false, dimmed: true })
  overlays[1].onMouseEnter?.({} as never)
  expect(hover).toHaveBeenLastCalledWith('boll')
  overlays[1].onMouseLeave?.({} as never)
  expect(hover).toHaveBeenLastCalledWith(null)
  const figures = levelTemplate.createPointFigures!({
    chart: { getStyles: () => ({ separator: { color: '#111' } }) },
    overlay: overlays[1], coordinates: [{ x: 10, y: 50 }, { x: 50, y: 60 }, { x: 70, y: 20 }], bounding: { width: 400, height: 200 },
  } as never)
  expect(figures).toMatchObject([{ type: 'line', attrs: { coordinates: [{ x: 50, y: 60 }, { x: 70, y: 20 }] } }, { type: 'text', attrs: { x: 262 } }])
})
it('无数据、非法价位或完全无有效曲线时不生成覆盖物', () => {
  expect(buildLevelOverlays([], [{ key: 'sr', value: 10 }], [], 144, null, undefined)).toEqual([])
  expect(buildLevelOverlays(bars, [{ key: 'sr', value: NaN }, { key: 'sr', value: 0 }], [{ key: 'atr', label: 'ATR', color: '#fff', data: [{ date: '2099-01-01', value: 1 }] }], 144, null, undefined)).toEqual([])
})
