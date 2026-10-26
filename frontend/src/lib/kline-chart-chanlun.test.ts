import { expect, it, vi } from 'vitest'
import { emptyChanlunAnalysis } from './chanlun'
import { toChartBars } from './kline-chart'
import { buildChanlunOverlays, chanlunTemplate } from './kline-chart-chanlun'

const bars = toChartBars(Array.from({ length: 4 }, (_, i) => ({ date: `2026-10-${12 + i}`, open: 10, close: 11, high: 12, low: 9 })), 1)
const config = { enabled: true, fractals: true, strokes: true, segments: true, centers: true, candidates: true, divergences: true }
function fixture() {
  const analysis = emptyChanlunAnalysis()
  Object.assign(analysis, {
    bars,
    fractals: [{ date: bars[0].date, price: 9, type: 'bottom', confirmedAt: bars[1].date }],
    strokes: [{ id: 'bi', startDate: bars[0].date, endDate: bars[1].date, startPrice: 9, endPrice: 12, direction: 'up', confirmed: true }],
    segments: [{ id: 'duan', startDate: bars[0].date, endDate: bars[3].date, startPrice: 9, endPrice: 12, direction: 'up', confirmed: false }],
    centers: [{ id: 'center', startDate: bars[1].date, endDate: bars[2].date, zd: 10, zg: 11 }],
    candidateSignals: [
      { id: 'buy', kind: 'first_buy', status: 'candidate', structureDate: bars[0].date, availableDate: bars[2].date, price: 10, boundary: 9 },
      { id: 'sell', kind: 'third_sell', status: 'invalidated', structureDate: bars[1].date, availableDate: bars[3].date, price: 12, boundary: 13 },
      { id: 'waiting', kind: 'second_buy', status: 'waiting_pullback', structureDate: bars[1].date, availableDate: bars[3].date, price: 12 },
    ],
    divergences: [{ id: 'bc', status: 'candidate', kind: 'trend', availableDate: bars[3].date, c: { endDate: bars[0].date }, evidence: '力度减弱' }],
  })
  return analysis
}

it('全部缠论结构迁移，候选点按可知日期定位，待确认状态不冒充候选', () => {
  const overlays = buildChanlunOverlays(bars, fixture(), config, '#aaa', false, vi.fn())
  expect(overlays).toHaveLength(5)
  expect(overlays.find(o => o.id?.endsWith('candidate-buy'))).toMatchObject({
    points: [{ timestamp: bars[2].timestamp, value: 10 }],
    extendData: { label: 'B1候选', tooltip: expect.stringContaining(`最早可知：${bars[2].date}`) },
  })
  expect(overlays.find(o => o.id?.endsWith('candidate-sell'))).toMatchObject({ extendData: { label: 'S3失效', invalidated: true, color: '#aaa' } })
  expect(overlays.find(o => o.id?.endsWith('center-center'))?.points?.map(p => p.value)).toEqual([10, 11])
  expect(overlays.every(o => o.lock)).toBe(true)
})

it('总开关、各层开关、空数据、无效价格及窗口外日期不残留结构', () => {
  const analysis = fixture()
  expect(buildChanlunOverlays(bars, analysis, { ...config, enabled: false }, '#aaa', false, vi.fn())).toEqual([])
  expect(buildChanlunOverlays([], analysis, config, '#aaa', false, vi.fn())).toEqual([])
  expect(buildChanlunOverlays(bars, undefined, config, '#aaa', false, vi.fn())).toEqual([])
  for (const key of ['fractals', 'strokes', 'segments', 'centers', 'candidates', 'divergences'] as const) {
    const only = Object.fromEntries(Object.keys(config).map(k => [k, k === 'enabled' || k === key])) as typeof config
    expect(buildChanlunOverlays(bars, analysis, only, '#aaa', false, vi.fn())).toHaveLength(key === 'candidates' ? 2 : key === 'segments' || key === 'divergences' ? 0 : 1)
  }
  analysis.strokes[0].endDate = '2099-01-01'
  analysis.fractals[0].price = NaN
  expect(buildChanlunOverlays(bars, analysis, config, '#aaa', false, vi.fn())).toHaveLength(3)
})

it('隐藏日期时结构提示不泄露日期，点击/右键保留原交互', () => {
  const tooltip = vi.fn(), click = vi.fn(), preventDefault = vi.fn()
  const overlays = buildChanlunOverlays(bars, fixture(), config, '#aaa', true, tooltip, click)
  const signal = overlays.find(o => o.id?.endsWith('candidate-buy'))!
  signal.onMouseEnter?.({} as never)
  expect(tooltip).toHaveBeenLastCalledWith('B1候选\n失效边界：9（本项目规则）')
  expect(JSON.stringify(overlays.map(o => o.extendData))).not.toContain('2026-10')
  signal.onMouseLeave?.({} as never)
  expect(tooltip).toHaveBeenLastCalledWith(null)
  signal.onClick?.({} as never)
  expect(click).toHaveBeenCalledWith(bars[2].date)
  signal.onRightClick?.({ preventDefault } as never)
  expect(preventDefault).toHaveBeenCalledOnce()
})

it('笔确认状态决定虚实，旧线段和背驰开关忽略，中枢为价格矩形，密集分型简化但候选文案保留', () => {
  const overlays = buildChanlunOverlays(bars, fixture(), config, '#aaa', false, vi.fn())
  const draw = (id: string, compact = false) => chanlunTemplate.createPointFigures!({
    chart: { getVisibleRange: () => ({ from: 0, to: compact ? 100 : 20 }) },
    overlay: overlays.find(o => o.id?.endsWith(id)), coordinates: [{ x: 10, y: 20 }, { x: 100, y: 60 }], bounding: { width: 400, height: 200 },
  } as never)
  expect(draw('stroke-bi')).toMatchObject([{ type: 'line', styles: { style: 'solid', size: 1.4 } }])
  expect(overlays.find(o => o.id?.endsWith('segment-duan'))).toBeUndefined()
  expect(draw('center-center')).toMatchObject([{ type: 'rect', attrs: { width: 90, height: 40 } }, { type: 'text' }])
  expect(draw('fractal-0', true)).toHaveLength(1)
  expect(draw('candidate-buy', true)).toHaveLength(2)
})

it('周月信号的实际周期结束日期投影到对应K线，而不提前丢失信号', () => {
  const weeklyBars = toChartBars([{ date: '2026-10-12', periodEnd: '2026-10-16', open: 10, close: 11, high: 12, low: 9 }], 1)
  const analysis = emptyChanlunAnalysis('1w')
  analysis.candidateSignals = [{ id: 'weekly', kind: 'first_buy', status: 'candidate', source: 'stroke', structureDate: '2026-10-05', availableDate: '2026-10-16', price: 10, boundary: 9, invalidatedAt: null, relatedSignalId: null, conditions: [], nextWatch: '' }]
  const overlays = buildChanlunOverlays(weeklyBars, analysis, config, '#aaa', false, vi.fn())
  expect(overlays).toHaveLength(1)
  expect(overlays[0].points?.[0].timestamp).toBe(weeklyBars[0].timestamp)
})
