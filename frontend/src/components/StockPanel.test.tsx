// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StockPanel } from './StockPanel'
import type { CandlestickProps } from '@/lib/kline-chart'
import type { StockLevels } from '@/lib/api'
import { emptyChanlunAnalysis } from '@/lib/chanlun'
import type { StockChanlunPanelProps } from './StockChanlunPanel'
const state = vi.hoisted(() => ({ chart: {} as CandlestickProps, levels: vi.fn(), chanlun: vi.fn(), structure: {} as StockChanlunPanelProps, daily: vi.fn(), catalog: vi.fn() }))
vi.mock('@/lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api')>(),
  api: {
    chartIndicators: state.catalog,
    klineDaily: async (symbol: string, _days: unknown, _range: unknown, _ext: unknown, _scores: unknown, chanlun: unknown, indicators: unknown) => { if (!chanlun) state.daily(symbol, indicators); return ({ asset_type: 'etf', chanlun: chanlun ? await state.chanlun(symbol, '1d', chanlun) : undefined, rows: [
      { date: '2026-10-14', open: 0.49, high: 0.5, low: 0.48, close: 0.49 },
      { date: '2026-10-15', open: 0.49, high: 0.5, low: 0.48, close: 0.497 },
    ] }) },
    klinePeriod: async (symbol: string, period: string, _range: unknown, _days: unknown, _scores: unknown, chanlun: unknown) => ({ asset_type: 'etf', chanlun: chanlun ? await state.chanlun(symbol, period, chanlun) : undefined, rows: [{ date: '2026-10-15', open: 0.49, high: 0.5, low: 0.48, close: 0.497 }] }),
    stockAnalysisLevels: state.levels,
  },
}))
vi.mock('./KLineCandlestick', async importOriginal => ({
  ...await importOriginal<typeof import('./KLineCandlestick')>(),
  KLineCandlestick: (props: CandlestickProps) => { state.chart = props; return <div>{props.toolbarControls}</div> },
}))
vi.mock('./StockInfoBar', () => ({ StockInfoBar: () => null }))
vi.mock('./StockIntradayChart', () => ({ StockIntradayChart: () => null }))
vi.mock('./StockTechnicalPanel', () => ({ StockTechnicalPanel: () => null }))
vi.mock('./StockChanlunPanel', () => ({ StockChanlunPanel: (props: StockChanlunPanelProps) => { state.structure = props; return <div /> } }))
vi.mock('./StockAiChatPanel', () => ({ StockAiChatPanel: () => null }))
vi.mock('@/lib/useSharedQueries', () => ({ useQuoteStatus: () => ({}) }))
const levels: StockLevels = {
  symbol: '512000.SH', asset_type: 'etf', close: 0.497, summary: '',
  levels: { sr: [{ type: 'sr', value: 0.49, label: '支撑', side: 'support' }],
    pivot: [{ type: 'pivot', value: 0.5, label: 'P', side: 'neutral', rank: 0 }, { type: 'pivot', value: 0.52, label: 'R2', side: 'resistance', rank: 2 }],
    boll: [{ type: 'boll', value: 0.51, label: '布林上轨', side: 'resistance' }],
    reversal_pivot: [{ type: 'reversal_pivot', value: 0.503, label: '拐点压力', side: 'resistance',
      pivot_date: '2026-10-10', confirmed_date: '2026-10-14' }],
    supply_demand: [
      { type: 'supply_demand', value: 0.51, lower: 0.50, upper: 0.52, side: 'resistance', label: '供给区', confirmed_date: '2026-10-14' },
      { type: 'supply_demand', value: 0.51, lower: 0.49, upper: 0.53, side: 'support', label: '需求区', confirmed_date: '2026-10-15' },
    ],
  } as StockLevels['levels'],
  dates: ['2026-10-14', '2026-10-15'], series: { boll: { upper: [0.51, 0.52], lower: [0.47, 0.48] } },
}
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear(); state.daily.mockClear(); state.catalog.mockReset().mockResolvedValue({ items: ['ma', 'vol'].map(id => ({ id, name: id === 'ma' ? 'MA 均线' : '成交量', source: 'custom', pane: id === 'ma' ? 'main' : 'sub', revision: 1, formula: '', description: '', height: 100 })), errors: [] }); state.levels.mockReset().mockResolvedValue(levels)
  state.chanlun.mockReset().mockResolvedValue(emptyChanlunAnalysis())
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 5_000 } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }) }
async function render(props: Partial<Parameters<typeof StockPanel>[0]> = {}) {
  await act(async () => root.render(<QueryClientProvider client={client}><StockPanel symbol="512000.SH" rightPaneMode="technical" {...props} /></QueryClientProvider>))
  await settle(); await settle()
}
async function click(label: string, role = 'button') {
  const element = [...host.querySelectorAll(role === 'tab' ? '[role="tab"]' : 'button')].find(button => (button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '').startsWith(label))
  expect(element, label).toBeDefined()
  await act(async () => (element as HTMLButtonElement).click()); await settle()
}
it('关键价位位于结构分析右边，按需加载，点击画线和曲线，再点移除，保留原有标线', async () => {
  await render({ priceLines: [{ value: 0.48, label: '自定义' }] })
  expect([...host.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['指标分析', '结构分析', '关键价位', 'AI分析'])
  expect(state.levels).not.toHaveBeenCalled()
  await click('关键价位', 'tab')
  expect(state.levels).toHaveBeenCalledWith('512000.SH', 250, '2026-10-15')
  expect(state.chart.priceLines).toEqual([{ value: 0.48, label: '自定义' }])
  await click('压力支撑')
  expect(state.chart.priceLines?.map(line => line.label)).toEqual(['自定义', '支撑'])
  await click('枢轴点'); await click('2')
  expect(state.chart.priceLines?.map(line => line.label)).toContain('R2')
  await click('布林带')
  expect(state.chart.priceCurves?.[0].data.map(row => row.value)).toEqual([0.51, 0.52])
  const previousCalls = state.levels.mock.calls.length
  await click('立即计算右侧分析')
  expect(state.levels.mock.calls.length).toBeGreaterThan(previousCalls)
  await click('结构分析', 'tab')
  expect(state.chart.priceLines?.map(line => line.label)).toContain('支撑')
  await click('关键价位', 'tab'); await click('压力支撑'); await click('布林带')
  expect(state.chart.priceLines?.some(line => line.label === '支撑')).toBe(false)
  expect(state.chart.priceCurves).toEqual([])
})
it('历史截面隔离查询，切股加载中清除旧价位，非日K提示口径并移除覆盖物', async () => {
  await render(); await click('关键价位', 'tab'); await click('压力支撑')
  await act(async () => state.chart.onDateClick?.('2026-10-14')); await settle()
  expect(state.levels).toHaveBeenLastCalledWith('512000.SH', 250, '2026-10-14')
  state.levels.mockImplementation(() => new Promise(() => {}))
  await render({ symbol: '159915.SZ' })
  expect(state.chart.priceLines).toEqual([])
  expect(host.textContent).toContain('关键价位加载中')
  await render({ period: '1d', lockedSelectedDate: '2026-10-15', visibleThrough: '2026-10-14' })
  expect(state.levels).toHaveBeenLastCalledWith('512000.SH', 250, '2026-10-14')
  await render({ period: '1w' })
  expect(state.chart.priceLines).toEqual([])
  expect(host.textContent).toContain('关键价位按日K计算')
})
it('反转拐点在关键价位中独立开关，保留确认日期和ETF精度', async () => {
  await render(); await click('关键价位', 'tab')
  expect(state.chart.priceLines).toEqual([])
  await click('反转拐点')
  expect(state.chart.priceLines).toMatchObject([{ value: 0.503, label: '拐点压力', start: '2026-10-14', type: 'reversal_pivot', affectScale: false }])
  expect(host.textContent).toContain('0.503')
  await click('反转拐点')
  expect(state.chart.priceLines).toEqual([])
})
it('供需区域绘制价格带和上下沿明细，同中点区域不共用高亮键，非日K清除区域', async () => {
  await render(); await click('关键价位', 'tab'); await click('供需区域')
  expect(state.chart.priceLines).toEqual([])
  expect(state.chart.priceZones).toMatchObject([
    { lower: 0.50, upper: 0.52, label: '供给区', start: '2026-10-14' },
    { lower: 0.49, upper: 0.53, label: '需求区', start: '2026-10-15' },
  ])
  expect(new Set(state.chart.priceZones?.map(zone => zone.key)).size).toBe(2)
  expect(host.textContent).toContain('0.500–0.520')
  expect(host.textContent).toContain('0.490–0.530')
  await click('供需区域')
  expect(state.chart.priceZones).toEqual([])
  await click('供需区域'); await render({ period: '1w' })
  expect(state.chart.priceZones).toEqual([])
})
it('错误可重试，无价位时提示，空组不可点击', async () => {
  state.levels.mockRejectedValue(new Error('failed'))
  await render(); await click('关键价位', 'tab'); await settle()
  expect(host.textContent).toContain('关键价位加载失败')
  state.levels.mockResolvedValue({ ...levels, close: null, levels: {}, dates: [], series: {} })
  await click('重试'); await settle()
  expect(host.textContent).toContain('暂无关键价位')
  state.levels.mockResolvedValue(levels)
  await render({ symbol: 'A' })
  const gap = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('缺口位')) as HTMLButtonElement
  expect(gap.disabled).toBe(true)
})

it('缠论使用后端结果，切历史、结构来源和标的时隔离结果，加载失败可重试', async () => {
  state.chanlun.mockResolvedValue({ ...emptyChanlunAnalysis(), currentPrice: 0.497 })
  await render(); await click('结构分析', 'tab')
  expect(state.chanlun).toHaveBeenLastCalledWith('512000.SH', '1d', { source: 'stroke', asOf: '2026-10-15' })
  expect(state.chart.chanlunAnalysis?.currentPrice).toBe(0.497)
  await act(async () => state.chart.onDateClick?.('2026-10-14')); await settle(); await settle()
  expect(state.chanlun).toHaveBeenLastCalledWith('512000.SH', '1d', { source: 'stroke', asOf: '2026-10-14' })
  await act(async () => state.structure.onSourceChange?.('segment')); await settle(); await settle()
  expect(state.chanlun).toHaveBeenLastCalledWith('512000.SH', '1d', { source: 'segment', asOf: '2026-10-14' })
  const dailyCalls = state.chanlun.mock.calls.filter(call => call[1] === '1d').length
  await act(async () => state.structure.onToggleMultiPeriod?.()); await settle(); await settle()
  expect(state.chanlun.mock.calls.filter(call => call[1] === '1d')).toHaveLength(dailyCalls)
  state.chanlun.mockRejectedValue(new Error('缠论不可用'))
  await render({ symbol: '159915.SZ' }); await settle()
  expect(state.chart.chanlunAnalysis?.currentPrice).toBeNull()
  expect(state.structure.error?.message).toBe('缠论不可用')
  state.chanlun.mockResolvedValue({ ...emptyChanlunAnalysis(), currentPrice: 2 })
  await act(async () => state.structure.onRetry?.()); await settle(); await settle()
  expect(state.chart.chanlunAnalysis?.currentPrice).toBe(2)
})

it('目录加载后信息条与图表只发一次行情请求，切换指标共享更新后的缓存键', async () => {
  let finish!: (value: unknown) => void
  const definitions = await state.catalog()
  state.catalog.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await render()
  expect(state.daily).not.toHaveBeenCalled()
  await act(async () => finish(definitions)); await settle(); await settle()
  expect(state.daily).toHaveBeenCalledTimes(1)
  expect(state.daily).toHaveBeenLastCalledWith('512000.SH', expect.objectContaining({ ids: ['ma', 'vol'] }))
  await click('指标'); await click('MA 均线')
  await settle(); await settle()
  expect(state.daily).toHaveBeenCalledTimes(2)
  expect(state.daily).toHaveBeenLastCalledWith('512000.SH', expect.objectContaining({ ids: ['vol'] }))
})
