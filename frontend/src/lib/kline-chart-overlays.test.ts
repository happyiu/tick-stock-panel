import { expect, it, vi } from 'vitest'
import type { Chart } from 'klinecharts'
import { annotationTemplate, buildAnnotations } from './kline-chart-overlays'
import { toChartBars } from './kline-chart'

const bars = toChartBars([
  { date: '2026-10-09', open: 10, high: 12, low: 9, close: 11 },
  { date: '2026-10-12', open: 11, high: 13, low: 10, close: 12 },
], 1)

it('自选日按最近前一交易日定位，区间和有限价格线保留日期边界', () => {
  const overlays = buildAnnotations(bars, [], [{ start: bars[0].date, end: bars[1].date, label: '持仓' }], [
    { value: 15, start: bars[0].date, end: bars[1].date, label: '止盈' }, { value: NaN }, { value: 0 },
  ], '2026-10-11', null, '#fff')
  expect(overlays).toHaveLength(3)
  expect(overlays[0].points?.map(p => p.timestamp)).toEqual(bars.map(b => b.timestamp))
  expect(overlays[1].points).toEqual(bars.map(b => ({ timestamp: b.timestamp, value: 15 })))
  expect(overlays[2].points).toEqual([{ timestamp: bars[0].timestamp, value: 9 }])
  expect(buildAnnotations(bars, [], [], [], '2026-10-08', null, '#fff')).toHaveLength(0)
})

it('标记点击保留日期回调，右键不会删除业务覆盖物', () => {
  const onDateClick = vi.fn(), preventDefault = vi.fn()
  const overlay = buildAnnotations(bars, [{ date: bars[0].date, kind: 'buy', label: '买' }], [], [], null, null, '#fff', onDateClick)[0]
  overlay.onClick?.({} as never)
  overlay.onRightClick?.({ preventDefault } as never)
  expect(onDateClick).toHaveBeenCalledWith(bars[0].date)
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(overlay.lock).toBe(true)
})

it('缩小后买卖箭头保留，涨停标签变圆点，分时联动价线横贯主图', () => {
  const draw = (annotation: unknown, coordinates = [{ x: 50, y: 80 }]) => annotationTemplate.createPointFigures!({
    chart: { getVisibleRange: () => ({ from: 0, to: 100 }), getStyles: () => ({ separator: { color: '#111' } }) } as unknown as Chart,
    overlay: { extendData: annotation }, coordinates, bounding: { width: 500, height: 300 },
  } as Parameters<NonNullable<typeof annotationTemplate.createPointFigures>>[0])
  expect(draw({ kind: 'marker', color: '#fff', above: true, arrow: true, label: '卖' })).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'polygon' })]))
  expect(draw({ kind: 'marker', color: '#fff', above: true, arrow: false, label: '板' })).toEqual([expect.objectContaining({ type: 'circle' })])
  expect(draw({ kind: 'price', color: '#fff' })).toEqual([expect.objectContaining({
    attrs: { coordinates: [{ x: 0, y: 80 }, { x: 500, y: 80 }] },
  })])
})
