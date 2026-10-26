import { expect, it, vi } from 'vitest'
import { emptyChanlunAnalysis } from './chanlun'
import { toChartBars } from './kline-chart'
import { buildChanlunOverlays, chanlunTemplate } from './kline-chart-chanlun'

const bars = toChartBars(Array.from({ length: 4 }, (_, i) => ({ date: `2026-10-${12 + i}`, open: 10, close: 11, high: 12, low: 9 })), 1)
const config = { enabled: true, fractals: true, strokes: true, segments: true, centers: true, candidates: true, divergences: true, trends: true, centerExtensions: true }
function fixture() {
  const analysis = emptyChanlunAnalysis()
  Object.assign(analysis, {
    bars,
    capabilities: { supportedSources: ['stroke'], segments: true, segmentRuleSource: 'project', divergences: true, trends: true, centerExtensions: true, recursiveConfirmation: false, signalRules: [] },
    fractals: [{ date: bars[0].date, price: 9, type: 'bottom', confirmedAt: bars[1].date }],
    strokes: [{ id: 'bi', startDate: bars[0].date, endDate: bars[1].date, startPrice: 9, endPrice: 12, direction: 'up', confirmed: true }],
    segments: [{ id: 'duan', startDate: bars[0].date, endDate: bars[3].date, startPrice: 9, endPrice: 12, direction: 'up', confirmed: false, observedAt: bars[3].date, componentCount: 3, ruleSource: 'project', rule: 'feature-sequence-v1' }],
    centers: [{ id: 'center', startDate: bars[1].date, endDate: bars[2].date, zd: 10, zg: 11 }],
    candidateSignals: [
      { id: 'buy', kind: 'first_buy', status: 'candidate', structureDate: bars[0].date, availableDate: bars[2].date, price: 10, boundary: 9 },
      { id: 'sell', kind: 'third_sell', status: 'invalidated', structureDate: bars[1].date, availableDate: bars[3].date, price: 12, boundary: 13 },
      { id: 'waiting', kind: 'second_buy', status: 'waiting_pullback', structureDate: bars[1].date, availableDate: bars[3].date, price: 12 },
    ],
    trends: [{ id: 'walk', direction: 'up', startDate: bars[0].date, endDate: bars[3].date, availableDate: bars[2].date, centerIds: ['a', 'b'], current: true, ruleSource: 'project', band: [{ date: bars[0].date, lower: 9, upper: 10 }, { date: bars[1].date, lower: 9, upper: 10 }, { date: bars[2].date, lower: 10, upper: 11 }, { date: bars[3].date, lower: 10, upper: 11 }] }],
    centerExtensions: [{ id: 'ext', centerId: 'center', startDate: bars[2].date, endDate: bars[3].date, availableDate: bars[2].date, zd: 10, zg: 11, latest: true, ruleSource: 'project' }],
    divergences: [{ id: 'bc', status: 'candidate', kind: 'macd', ruleSource: 'czsc', direction: 'up', availableDate: bars[3].date, structureDate: bars[2].date, price: 12, references: [{ endDate: bars[0].date, endPrice: 11 }, { endDate: bars[1].date, endPrice: 12 }], rule: { function: 'tas_macd_bc_V230804', params: { di: 1 } }, rawSignal: { key: 'MACD背驰', value: '空头_任意_任意_0' }, evidence: '官方MACD背驰条件命中，仅作观察' }],
  })
  return analysis
}

it('全部缠论结构迁移，候选点按可知日期定位，待确认状态不冒充候选', () => {
  const overlays = buildChanlunOverlays(bars, fixture(), config, '#aaa', false, vi.fn())
  expect(overlays).toHaveLength(12)
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
  const counts = { fractals: 1, strokes: 1, segments: 1, centers: 1, candidates: 2, divergences: 3, trends: 1, centerExtensions: 2 }
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
    const only = Object.fromEntries(Object.keys(config).map(k => [k, k === 'enabled' || k === key])) as typeof config
    expect(buildChanlunOverlays(bars, analysis, only, '#aaa', false, vi.fn())).toHaveLength(counts[key])
  }
  analysis.strokes[0].endDate = '2099-01-01'
  analysis.fractals[0].price = NaN
  expect(buildChanlunOverlays(bars, analysis, config, '#aaa', false, vi.fn())).toHaveLength(10)
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

it('笔及线段确认状态决定虚实，中枢为矩形，密集图保留信号和背驰观察文字', () => {
  const overlays = buildChanlunOverlays(bars, fixture(), config, '#aaa', false, vi.fn())
  const draw = (id: string, compact = false) => chanlunTemplate.createPointFigures!({
    chart: { getVisibleRange: () => ({ from: 0, to: compact ? 100 : 20 }) },
    overlay: overlays.find(o => o.id?.endsWith(id)), coordinates: [{ x: 10, y: 20 }, { x: 100, y: 60 }], bounding: { width: 400, height: 200 },
  } as never)
  expect(draw('stroke-bi')).toMatchObject([{ type: 'line', styles: { style: 'solid', size: 1.4 } }])
  expect(draw('segment-duan')).toMatchObject([{ type: 'line', styles: { style: 'dashed', size: 2.4 } }])
  expect(draw('center-center')).toMatchObject([{ type: 'rect', attrs: { width: 90, height: 40 } }, { type: 'text' }])
  expect(draw('fractal-0', true)).toHaveLength(1)
  expect(draw('candidate-buy', true)).toHaveLength(2)
  expect(draw('divergence-bc', true)).toHaveLength(2)
})

it('旧口径线段与背驰不会被新图层误用，缺少能力时不绘制', () => {
  const a = fixture()
  delete a.segments[0].ruleSource
  a.divergences[0].kind = 'trend'
  let overlays = buildChanlunOverlays(bars, a, config, '#aaa', false, vi.fn())
  expect(overlays.some(o => /segment-|divergence-/.test(o.id!))).toBe(false)
  a.capabilities = emptyChanlunAnalysis().capabilities
  overlays = buildChanlunOverlays(bars, a, config, '#aaa', false, vi.fn())
  expect(overlays.some(o => /trend-|extension-|segment-|divergence-/.test(o.id!))).toBe(false)
})

it('趋势云带来自中枢上下沿，背驰标在首次可知位置，点击不回到不可知的极值日', () => {
  const click = vi.fn(), a = fixture()
  const overlays = buildChanlunOverlays(bars, a, config, '#aaa', false, vi.fn(), click)
  const trend = overlays.find(o => o.id?.endsWith('trend-walk'))!
  expect(trend.points).toHaveLength(8)
  expect(trend.points?.map(p => p.value)).toEqual([10, 10, 11, 11, 10, 10, 9, 9])
  const figures = chanlunTemplate.createPointFigures!({ chart: { getVisibleRange: () => ({ from: 0, to: 20 }) }, overlay: trend, coordinates: trend.points?.map((p, i) => ({ x: i * 10, y: p.value })), bounding: { width: 400, height: 200 } } as never)
  expect(figures).toMatchObject([{ type: 'polygon' }, { type: 'line', styles: { style: 'dashed' } }, { type: 'line' }, { type: 'text' }])
  const divergence = overlays.find(o => o.id?.endsWith('divergence-bc'))!
  expect(divergence.points).toEqual([{ timestamp: bars[3].timestamp, value: 12 }])
  divergence.onClick?.({} as never)
  expect(click).toHaveBeenCalledWith(bars[3].date)
})

it('零宽中枢只画一条延长线，失效背驰保留灰色记录', () => {
  const a = fixture()
  a.centerExtensions![0].zg = a.centerExtensions![0].zd
  a.divergences[0].status = 'invalidated'
  a.divergences[0].invalidatedAt = bars[3].date
  const overlays = buildChanlunOverlays(bars, a, config, '#aaa', true, vi.fn())
  expect(overlays.filter(o => o.id?.includes('extension-'))).toHaveLength(1)
  expect(overlays.find(o => o.id?.endsWith('divergence-bc'))?.extendData).toMatchObject({ color: '#aaa', invalidated: true, label: '顶背驰观察失效' })
  expect(JSON.stringify(overlays.map(o => o.extendData))).not.toContain('2026-10')
})

it('周月信号的实际周期结束日期投影到对应K线，而不提前丢失信号', () => {
  const weeklyBars = toChartBars([{ date: '2026-10-12', periodEnd: '2026-10-16', open: 10, close: 11, high: 12, low: 9 }], 1)
  const analysis = emptyChanlunAnalysis('1w')
  analysis.candidateSignals = [{ id: 'weekly', kind: 'first_buy', status: 'candidate', source: 'stroke', structureDate: '2026-10-05', availableDate: '2026-10-16', price: 10, boundary: 9, invalidatedAt: null, relatedSignalId: null, conditions: [], nextWatch: '' }]
  const overlays = buildChanlunOverlays(weeklyBars, analysis, config, '#aaa', false, vi.fn())
  expect(overlays).toHaveLength(1)
  expect(overlays[0].points?.[0].timestamp).toBe(weeklyBars[0].timestamp)
})

it('窗口外的历史背驰不挤入左侧，密集时失效记录保留标记和详情', () => {
  const a = fixture()
  a.divergences[0].status = 'invalidated'
  const overlay = buildChanlunOverlays(bars, a, config, '#aaa', false, vi.fn()).find(o => o.id?.endsWith('divergence-bc'))!
  const draw = (x: number, dense: boolean) => chanlunTemplate.createPointFigures!({
    chart: { getVisibleRange: () => ({ from: 0, to: dense ? 100 : 20 }) }, overlay,
    coordinates: [{ x, y: 50 }], bounding: { width: 400, height: 200 },
  } as never)
  expect(draw(-50, false)).toEqual([])
  expect(draw(450, false)).toEqual([])
  expect(draw(100, true)).toMatchObject([{ type: 'polygon' }])
  expect(draw(100, false)).toMatchObject([{ type: 'polygon' }, { type: 'text' }])
  expect(overlay.extendData).toMatchObject({ tooltip: expect.stringContaining('失效') })
})
