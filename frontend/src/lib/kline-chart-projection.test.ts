import { expect, it, vi } from 'vitest'
import type { ChanlunProjection } from './chanlun'
import { toChartBars } from './kline-chart'
import { buildProjectionOverlay, projectionTemplate, projectionWidth } from './kline-chart-projection'

const bars = toChartBars([{ date: '2026-10-26', open: 10, high: 12, low: 8, close: 10 }], 1)
const projection: ChanlunProjection = {
  version: 1, ruleSource: 'project', status: 'ready', side: 'inside', description: '条件示意',
  anchor: { date: bars[0].date, availableDate: bars[0].date, price: 10 },
  center: { kind: 'current', label: '当前中枢', centerId: 'a', zd: 9, zg: 11, formedAt: bars[0].date },
  zones: [{ kind: 'current', label: '当前中枢', centerId: 'a', zd: 9, zg: 11, formedAt: bars[0].date }],
  branches: ['upper', 'lower', 'middle'].map((target, i) => ({ id: i + 1, label: `分支${i + 1}`, target, condition: '等待条件', meaning: '观察' })) as ChanlunProjection['branches'],
}

it('条件图只锚定真实收盘，不伪造未来K线日期，分支点击返回对应编号', () => {
  const select = vi.fn(), overlays = buildProjectionOverlay(bars, projection, 'dark', 'etf', 2, select)
  expect(overlays).toHaveLength(1)
  expect(overlays[0].points?.every(p => p.timestamp === bars[0].timestamp)).toBe(true)
  overlays[0].onClick?.({ figure: { key: 'branch-2' } } as never)
  expect(select).toHaveBeenCalledWith(2)
  overlays[0].onClick?.({ figure: {} } as never)
  expect(select).toHaveBeenCalledOnce()
  const figures = projectionTemplate.createPointFigures!({
    overlay: overlays[0], coordinates: [{ x: 500, y: 110 }, { x: 500, y: 80 }, { x: 500, y: 140 }], bounding: { width: 800, height: 300 },
  } as never) as { type: string; key?: string; styles?: { size?: number } }[]
  expect(figures.filter(f => f.type === 'circle')).toHaveLength(3)
  expect(figures.find(f => f.type === 'line' && f.key === 'branch-2')?.styles?.size).toBe(2.5)
  const axis = projectionTemplate.createXAxisFigures!({ overlay: overlays[0], bounding: { width: 800, height: 22 } } as never)
  expect(axis).toMatchObject([{ type: 'rect', attrs: { x: 580, width: 220 } }, { type: 'text', attrs: { text: '条件示意区 · 无时间刻度' } }])
})

it('空结果、缺少锚点或历史锚点不在图表末尾时安全拒绝绘图', () => {
  expect(buildProjectionOverlay(bars, undefined, 'dark', undefined, null, vi.fn())).toEqual([])
  expect(buildProjectionOverlay([], projection, 'dark', undefined, null, vi.fn())).toEqual([])
  expect(buildProjectionOverlay(bars, { ...projection, anchor: null }, 'dark', undefined, null, vi.fn())).toEqual([])
  const later = toChartBars([{ date: '2026-10-27', open: 10, high: 12, low: 8, close: 10 }], 1)
  expect(buildProjectionOverlay([...bars, ...later], projection, 'dark', undefined, null, vi.fn())).toEqual([])
})

it('窄屏双主题、零宽中枢和无中枢均有可绘制的空态', () => {
  for (const width of [240, 800]) for (const theme of ['light', 'dark'] as const) {
    expect(projectionWidth(width)).toBeLessThanOrEqual(width * 0.48)
    const p = { ...projection, status: 'insufficient' as const, center: null, zones: [], branches: [] }
    const overlay = buildProjectionOverlay(bars, p, theme, 'etf', null, vi.fn())[0]
    const draw = (height: number) => projectionTemplate.createPointFigures!({ overlay, coordinates: [{ x: 10, y: 10 }], bounding: { width, height } } as never)
    expect(JSON.stringify(draw(300))).toContain('此处尚无有效中枢')
    expect(draw(90)).toEqual([])
  }
  const flat = { ...projection, zones: [{ ...projection.zones[0], zd: 10, zg: 10 }] }
  expect(buildProjectionOverlay(bars, flat, 'dark', undefined, null, vi.fn())).toHaveLength(1)
})
