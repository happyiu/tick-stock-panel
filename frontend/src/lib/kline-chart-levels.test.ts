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
it('拐点线从确认日延续，窗口前确认的价位继续显示，未来确认的线不画', () => {
  const overlays = buildLevelOverlays(bars, [
    { key: 'recent', value: 12, label: '拐点压力', start: bars[2].date },
    { key: 'old', value: 9, label: '拐点支撑', start: '2026-09-01' },
    { key: 'future', value: 15, start: '2026-10-20' },
  ], [], 144, null, undefined)
  expect(overlays).toHaveLength(2)
  expect(overlays[0].points).toEqual([{ timestamp: bars[2].timestamp, value: 12 }])
  expect(overlays[1].points).toEqual([{ timestamp: bars[0].timestamp, value: 9 }])
  const figures = levelTemplate.createPointFigures!({
    chart: { getStyles: () => ({ separator: { color: '#111' } }) },
    overlay: overlays[0], coordinates: [{ x: 80, y: 30 }], bounding: { width: 400, height: 200 },
  } as never)
  expect(figures).toMatchObject([
    { type: 'line', attrs: { coordinates: [{ x: 80, y: 30 }, { x: 256, y: 30 }] } },
    { type: 'text' },
  ])
})
it('供需区域按上下沿画矩形并联动高亮，历史形成区域延续，未来或非法区域不画', () => {
  const hover = vi.fn()
  const overlays = buildLevelOverlays(bars, [], [], 144, 'supply', hover, 'etf', [
    { key: 'supply', label: '供给区', lower: 10, upper: 12, start: bars[1].date, color: '#EF4444' },
    { key: 'demand', label: '需求区', lower: 8, upper: 9, start: '2026-09-01', color: '#22C55E' },
    { key: 'future', label: '未来', lower: 8, upper: 9, start: '2026-10-20', color: '#fff' },
    { key: 'invalid', label: '非法', lower: 10, upper: 9, start: bars[1].date, color: '#fff' },
  ])
  expect(overlays).toHaveLength(2)
  expect(overlays[0].points).toEqual([
    { timestamp: bars[1].timestamp, value: 10 }, { timestamp: bars[1].timestamp, value: 12 },
  ])
  expect(overlays[0].extendData).toMatchObject({ zone: true, highlighted: true, label: '供给区 10.000–12.000' })
  const figures = levelTemplate.createPointFigures!({
    overlay: overlays[0], coordinates: [{ x: 40, y: 80 }, { x: 40, y: 20 }], bounding: { width: 400, height: 200 },
    chart: { getStyles: () => ({ separator: { color: '#111' } }) },
  } as never)
  expect(figures).toMatchObject([
    { type: 'rect', attrs: { x: 40, y: 20, width: 360, height: 60 }, styles: { style: 'stroke_fill' } },
    { type: 'text' },
  ])
  overlays[0].onMouseEnter?.({} as never)
  expect(hover).toHaveBeenLastCalledWith('supply')
  const recent = levelTemplate.createPointFigures!({
    overlay: overlays[0], coordinates: [{ x: 350, y: 80 }, { x: 350, y: 20 }], bounding: { width: 400, height: 200 },
    chart: { getStyles: () => ({ separator: { color: '#111' } }) },
  } as never)
  expect(recent).toMatchObject([{ type: 'rect', attrs: { x: 350, width: 50 } }, { type: 'text' }])
})
