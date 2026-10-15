// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DataLoader, KLineData } from 'klinecharts'
import { KLineCandlestick, usesLegacyChart, type OHLC } from './KLineCandlestick'

vi.mock('./EChartsCandlestick', async importOriginal => ({
  ...await importOriginal<typeof import('./EChartsCandlestick')>(),
  EChartsCandlestick: ({ activeIndicators, hideCurrentDate }: { activeIndicators?: string[]; hideCurrentDate?: boolean }) =>
    <div data-legacy-chart data-indicators={activeIndicators?.join(',')} data-hidden-date={hideCurrentDate} />,
}))

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (value: unknown) => void>,
  loader: null as DataLoader | null,
  bars: [] as KLineData[], symbol: '',
  indicators: [] as { name: string; id: string; paneId: string }[],
  frames: [] as FrameRequestCallback[],
}))
const chart = vi.hoisted(() => ({
  setSymbol: vi.fn(), setPeriod: vi.fn(), setDataLoader: vi.fn(), resetData: vi.fn(),
  setStyles: vi.fn(), setPaneOptions: vi.fn(), resize: vi.fn(),
  getIndicators: vi.fn(), createIndicator: vi.fn(), overrideIndicator: vi.fn(), removeIndicator: vi.fn(),
  createOverlay: vi.fn(), removeOverlay: vi.fn(), overrideYAxis: vi.fn(),
  subscribeAction: vi.fn(), unsubscribeAction: vi.fn(),
  setBarSpace: vi.fn(), setOffsetRightDistance: vi.fn(), scrollToRealTime: vi.fn(), scrollToTimestamp: vi.fn(),
  getBarSpace: () => ({ bar: 12 }), getVisibleRange: () => ({ from: 1, to: 3 }),
  getSize: () => ({ width: 800, height: 300 }), getDom: vi.fn(),
  convertFromPixel: vi.fn(() => [{ value: 11.25 }]),
}))
const engine = vi.hoisted(() => ({ init: vi.fn(), dispose: vi.fn(), registerIndicator: vi.fn(), registerOverlay: vi.fn() }))
vi.mock('klinecharts', () => engine)

const rows = (base = 10): OHLC[] => Array.from({ length: 5 }, (_, i) => ({
  date: `2026-10-${String(i + 1).padStart(2, '0')}`,
  open: base, high: base + 2, low: base - 1, close: base + 1, volume: 100,
}))
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const load = () => state.loader?.getBars({
  type: 'init', timestamp: null, symbol: { ticker: state.symbol, pricePrecision: 2, volumePrecision: 0 }, period: { span: 1, type: 'day' },
  callback: bars => {
    state.bars = bars
    state.loader?.subscribeBar?.({ symbol: { ticker: state.symbol, pricePrecision: 2, volumePrecision: 0 }, period: { span: 1, type: 'day' }, callback: bar => {
      if (state.bars.at(-1)?.timestamp === bar.timestamp) state.bars = [...state.bars.slice(0, -1), bar]
      else state.bars = [...state.bars, bar]
    } })
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  state.handlers = {}; state.indicators = []; state.frames = []; state.loader = null; state.symbol = ''; state.bars = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { state.frames.push(cb); return state.frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  engine.init.mockReturnValue(chart)
  chart.subscribeAction.mockImplementation((name: string, cb: (value: unknown) => void) => { state.handlers[name] = cb })
  chart.setSymbol.mockImplementation(({ ticker }: { ticker: string }) => { state.symbol = ticker; if (state.loader) load() })
  chart.setPeriod.mockImplementation(() => { if (state.loader) load() })
  chart.setDataLoader.mockImplementation((loader: DataLoader) => { state.loader = loader; load() })
  chart.resetData.mockImplementation(load)
  chart.getIndicators.mockImplementation((filter?: { name: string }) => state.indicators.filter(i => !filter || i.name === filter.name))
  chart.createIndicator.mockImplementation((indicator: { name: string; paneId: string }) => {
    const id = indicator.name
    state.indicators.push({ ...indicator, id }); return id
  })
  chart.removeIndicator.mockImplementation(({ id }: { id: string }) => { state.indicators = state.indicators.filter(i => i.id !== id) })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  chart.getDom.mockReturnValue(host)
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 800, height: 300 } as DOMRect)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function render(props: Partial<Parameters<typeof KLineCandlestick>[0]> = {}) {
  await act(async () => root.render(<KLineCandlestick data={rows()} symbol="A" {...props} />))
  await act(async () => { state.frames.splice(0).forEach(cb => cb(0)) })
}

it('同日更新和追加新日不重置视图，历史修订恢复浏览位置', async () => {
  const data = rows()
  await render({ data })
  chart.resetData.mockClear(); chart.scrollToRealTime.mockClear()
  await render({ data: [...data.slice(0, -1), { ...data.at(-1)!, close: 12 }] })
  expect(state.bars.at(-1)?.close).toBe(12)
  await render({ data: [...data.slice(0, -1), { ...data.at(-1)!, close: 12 }, { ...data[0], date: '2026-10-06' }] })
  expect(state.bars).toHaveLength(6)
  expect(chart.resetData).not.toHaveBeenCalled()
  expect(chart.scrollToRealTime).not.toHaveBeenCalled()
  await render({ data: [{ ...data[0], ma5: 999 }, ...data.slice(1)] })
  expect(chart.resetData).toHaveBeenCalledOnce()
  expect(chart.scrollToTimestamp).toHaveBeenCalledWith(Date.parse('2026-10-03T00:00:00+08:00'))
  expect(engine.init).toHaveBeenCalledOnce()
})

it('切股清掉旧悬停和标记，当前十字线命中后恢复至今/周期', async () => {
  await render({ markers: [{ date: rows()[1].date, kind: 'buy', label: 'A买' }] })
  await act(async () => state.handlers.onCrosshairChange({ dataIndex: 2 }))
  expect(host.textContent).toContain('至今')
  await render({ symbol: 'B', data: rows(100), markers: [{ date: rows()[2].date, kind: 'sell', label: 'B卖' }] })
  expect(state.bars[0].open).toBe(100)
  expect(host.textContent).not.toContain('至今')
  const overlays = chart.createOverlay.mock.calls.at(-1)![0]
  expect(JSON.stringify(overlays)).toContain('B卖')
  expect(JSON.stringify(overlays)).not.toContain('A买')
  await act(async () => state.handlers.onCrosshairChange({ dataIndex: 1 }))
  expect(host.textContent).toContain('周期 4')
  const surface = host.firstElementChild!
  await act(async () => surface.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
  expect(host.textContent).not.toContain('至今')
})

it('副图开关与顺序、BOLL、量能配置复用同一个实例', async () => {
  await render({ activeIndicators: ['vol', 'macd'] })
  expect(state.indicators.map(i => i.name)).toEqual(['TSP_MA', 'TSP_VOL', 'TSP_MACD'])
  await render({ activeIndicators: ['rsi', 'vol', 'kdj', 'boll'], volumeCompare: { enabled: false, days: 5 } })
  expect(state.indicators.some(i => i.name === 'TSP_MACD')).toBe(false)
  expect(state.indicators.map(i => i.name)).toEqual(expect.arrayContaining(['TSP_RSI', 'TSP_KDJ', 'TSP_BOLL']))
  expect(chart.setPaneOptions).toHaveBeenCalledWith(expect.objectContaining({ id: 'tsp_rsi', order: 1 }))
  expect(chart.overrideIndicator).toHaveBeenCalledWith(expect.objectContaining({ name: 'TSP_VOL', extendData: false, calcParams: [5] }))
  expect(engine.init).toHaveBeenCalledOnce()
})

it('日期点击与主图双击使用当前回调，副图区不触发价格预警', async () => {
  const onDateClick = vi.fn(), onPriceDoubleClick = vi.fn()
  await render({ onDateClick, onPriceDoubleClick })
  await act(async () => state.handlers.onCandleBarClick({ dataIndex: 1 }))
  expect(onDateClick).toHaveBeenCalledWith('2026-10-02')
  const canvas = host.querySelector('[data-kline-chart]')!
  await act(async () => canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 100 })))
  expect(onPriceDoubleClick).toHaveBeenCalledWith(11.25, 11)
  await act(async () => canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 350 })))
  expect(onPriceDoubleClick).toHaveBeenCalledOnce()
})

it('预警价线参与纵轴范围；无效数据有空态；卸载销毁图表', async () => {
  await render({ priceLines: [{ value: 50, label: '预警' }] })
  const createRange = chart.overrideYAxis.mock.calls.at(-1)![0].createRange
  expect(createRange({ defaultRange: { from: 9, to: 12 } })).toMatchObject({ from: 9, to: 50, realRange: 41 })
  await render({ data: [] })
  expect(host.textContent).toContain('暂无有效日K数据')
  await act(async () => root.render(null))
  expect(engine.dispose).toHaveBeenCalledOnce()
})

it('dev 自定义公式和隐藏日期调试保留原引擎，普通指标使用新引擎', async () => {
  for (const key of ['angel-devil', 'boll2', 'kd-divergence', 'kd-enhanced', 'etf-swing-v2', 'bull-bear-trend-v2']) {
    expect(usesLegacyChart({ data: rows(), activeIndicators: [key] })).toBe(true)
  }
  await render({ activeIndicators: ['kd-enhanced', 'etf-swing-v2', 'bull-bear-trend-v2'] })
  expect(host.querySelector('[data-legacy-chart]')?.getAttribute('data-indicators')).toBe('kd-enhanced,etf-swing-v2,bull-bear-trend-v2')
  expect(engine.init).not.toHaveBeenCalled()
  await render({ activeIndicators: ['vol', 'macd'] })
  expect(host.querySelector('[data-kline-chart]')).not.toBeNull()
  await render({ hideCurrentDate: true })
  expect(host.querySelector('[data-legacy-chart]')?.getAttribute('data-hidden-date')).toBe('true')
})

it('缠论开关决定原引擎路径，30分钟切换和ETF三位价格保留', async () => {
  expect(usesLegacyChart({ data: rows(), chanlunAnalysis: {} as never, chanlunOverlay: { enabled: true } as never })).toBe(true)
  expect(usesLegacyChart({ data: rows(), chanlunAnalysis: {} as never, chanlunOverlay: { enabled: false } as never })).toBe(false)
  await render({ assetType: 'etf', data: rows(0.497) })
  expect(chart.setSymbol).toHaveBeenCalledWith(expect.objectContaining({ pricePrecision: 3 }))
  expect(host.textContent).toContain('0.497')
  await render({ assetType: 'etf', period: '30m', data: [{ ...rows(0.497)[0], date: '2026-10-01 10:00' }] })
  expect(chart.setPeriod).toHaveBeenLastCalledWith({ span: 30, type: 'minute' })
  expect(state.bars[0].timestamp).toBe(Date.parse('2026-10-01T10:00:00+08:00'))
})
