import { expect, it } from 'vitest'
import { buildPatternOverlays, PATTERN_GROUP } from './kline-chart-patterns'
import type { PatternHit } from './trendPatterns'
import { toChartBars } from './kline-chart'
const bars = toChartBars([{ date: '2026-10-29', open: 10, high: 12, low: 9, close: 11 }], 1)
const hit = { name: '双底', date: '2026-10-29', status: 'forming', triggerPrice: 12, stopPrice: 9, targetPrice: null, geometry: { start: '2026-10-29', end: '2026-10-29', paths: [], zones: [] } } as unknown as PatternHit
it('高亮真实蜡烛，独立分组且锁定，不伪造缺失目标', () => {
 const result = buildPatternOverlays(bars, hit)
 expect(result.incomplete).toBe(false)
 expect(result.overlays.every(o => o.groupId === PATTERN_GROUP && o.lock)).toBe(true)
 expect(JSON.stringify(result.overlays)).toContain('失效价')
 expect(JSON.stringify(result.overlays)).not.toContain('测量目标')
})
it('缺失坐标不连线，提示数据不完整', () => {
 const result = buildPatternOverlays(bars, { ...hit, geometry: { ...hit.geometry!, paths: [{ label: '颈线', points: [{ date: '2026-10-28', price: 10 }, { date: '2026-10-29', price: 12 }] }] } })
 expect(result.incomplete).toBe(true)
 expect(result.overlays.some(o => o.name === 'TSP_CHANLUN')).toBe(false)
 expect(buildPatternOverlays(bars, { ...hit, geometry: undefined }).incomplete).toBe(true)
})
