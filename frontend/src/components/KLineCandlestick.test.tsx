// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DataLoader, KLineData, OverlayCreate } from 'klinecharts'
import { KLineCandlestick, type OHLC } from './KLineCandlestick'
import { emptyChanlunAnalysis } from '@/lib/chanlun'

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (value: unknown) => void>,
  loader: null as DataLoader | null,
  bars: [] as KLineData[], symbol: '',
  indicators: [] as { name: string; id: string; paneId: string }[],
  frames: [] as FrameRequestCallback[],
  panes: {} as Record<string, { height: number; minHeight?: number; order?: number }>,
  width: 800,
  resize: null as (() => void) | null,
  overlays: [] as OverlayCreate[],
}))
const chart = vi.hoisted(() => ({
  setSymbol: vi.fn(), setPeriod: vi.fn(), setDataLoader: vi.fn(), resetData: vi.fn(),
  setStyles: vi.fn(), setPaneOptions: vi.fn(), resize: vi.fn(),
  getIndicators: vi.fn(), createIndicator: vi.fn(), overrideIndicator: vi.fn(), removeIndicator: vi.fn(),
  createOverlay: vi.fn(), getOverlays: vi.fn(), overrideOverlay: vi.fn(), removeOverlay: vi.fn(), overrideYAxis: vi.fn(),
  subscribeAction: vi.fn(), unsubscribeAction: vi.fn(),
  setBarSpace: vi.fn(), setOffsetRightDistance: vi.fn(), scrollToRealTime: vi.fn(), scrollToTimestamp: vi.fn(), scrollToDataIndex: vi.fn(), scrollByDistance: vi.fn(),
  getBarSpace: () => ({ bar: 12 }), getVisibleRange: () => ({ from: 1, to: 3 }),
  getSize: vi.fn(), getPaneOptions: vi.fn(), getDom: vi.fn(),
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
  localStorage.removeItem('stock_preview_sub_chart_heights')
  localStorage.removeItem('stock_preview_hidden_ma_lines')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  state.handlers = {}; state.indicators = []; state.frames = []; state.loader = null; state.symbol = ''; state.bars = []
  state.panes = {}; state.width = 800; state.resize = null
  state.overlays = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { state.frames.push(cb); return state.frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { state.resize = callback } observe() {} disconnect() {} })
  engine.init.mockImplementation(() => {
    state.panes = { candle_pane: { height: 300, order: 0 }, x_axis_pane: { height: 22, order: Number.MAX_SAFE_INTEGER } }
    return chart
  })
  chart.subscribeAction.mockImplementation((name: string, cb: (value: unknown) => void) => { state.handlers[name] = cb })
  chart.setSymbol.mockImplementation(({ ticker }: { ticker: string }) => { state.symbol = ticker; if (state.loader) load() })
  chart.setPeriod.mockImplementation(() => { if (state.loader) load() })
  chart.setDataLoader.mockImplementation((loader: DataLoader) => { state.loader = loader; load() })
  chart.resetData.mockImplementation(load)
  chart.getOverlays.mockImplementation((filter: { groupId: string }) => state.overlays.filter(overlay => overlay.groupId === filter.groupId))
  chart.createOverlay.mockImplementation((overlays: OverlayCreate | OverlayCreate[]) => { state.overlays.push(...[overlays].flat()) })
  chart.removeOverlay.mockImplementation((filter: { groupId?: string; id?: string }) => {
    state.overlays = state.overlays.filter(overlay => filter.id ? overlay.id !== filter.id : overlay.groupId !== filter.groupId)
  })
  chart.overrideOverlay.mockImplementation((overlay: OverlayCreate) => {
    state.overlays = state.overlays.map(current => current.id === overlay.id ? overlay : current)
  })
  chart.getIndicators.mockImplementation((filter?: { name: string }) => state.indicators.filter(i => !filter || i.name === filter.name))
  chart.getSize.mockImplementation((id: string) => ({ width: state.width, height: state.panes[id]?.height ?? 300 }))
  chart.getPaneOptions.mockImplementation((id: string) => state.panes[id] ? { id, ...state.panes[id] } : null)
  chart.setPaneOptions.mockImplementation(({ id, ...options }: { id: string; height?: number; minHeight?: number }) => {
    state.panes[id] = { ...(state.panes[id] ?? { height: 100 }), ...options }
  })
  chart.createIndicator.mockImplementation((indicator: { name: string; paneId: string }) => {
    const id = indicator.name
    state.indicators.push({ ...indicator, id }); return id
  })
  chart.removeIndicator.mockImplementation(({ id }: { id: string }) => {
    const paneId = state.indicators.find(i => i.id === id)?.paneId
    state.indicators = state.indicators.filter(i => i.id !== id)
    if (paneId && paneId !== 'candle_pane') delete state.panes[paneId]
  })
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

it('MA单线选择立即保存，关闭重开及新图表切股切周期后恢复，非法配置安全回退', async () => {
  const data = rows().map(row => ({ ...row, ma5: 10, ma10: 11, ma20: 12, ma60: 13 }))
  await render({ data })
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="隐藏 MA20"]')!.click())
  expect(JSON.parse(localStorage.getItem('stock_preview_hidden_ma_lines')!)).toEqual(['ma20'])
  await act(async () => root.render(null))
  await render({ data, symbol: 'B', period: '1w' })
  expect(host.querySelector('[aria-label="显示 MA20"]')?.getAttribute('aria-pressed')).toBe('false')
  expect(chart.overrideIndicator.mock.calls.at(-1)![0].figures.map((figure: { key: string }) => figure.key)).toEqual(['ma5', 'ma10', 'ma60'])
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="显示 MA20"]')!.click())
  expect(JSON.parse(localStorage.getItem('stock_preview_hidden_ma_lines')!)).toEqual([])
  for (const value of [null, {}, ['unknown', 10], 'broken']) {
    await act(async () => root.render(null))
    localStorage.setItem('stock_preview_hidden_ma_lines', JSON.stringify(value))
    await render({ data })
    expect(host.querySelector('[aria-label="隐藏 MA20"]')).not.toBeNull()
  }
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

it('量能控件放在成交量副图内，留出独立一行，移除副图时隐藏，重开恢复', async () => {
  const pane = document.createElement('div')
  pane.setAttribute('data-volume-pane', '')
  chart.getDom.mockImplementation((id?: string) => {
    if (id !== 'tsp_vol') return host
    if (!pane.isConnected) host.querySelector('[data-kline-chart]')!.append(pane)
    return pane
  })
  const change = vi.fn()
  const volumeCompareControls = <button onClick={change}>量能设置</button>
  await render({ activeIndicators: ['vol', 'macd'], volumeCompareControls })
  expect(pane.textContent).toContain('量能设置')
  expect(state.panes.tsp_vol.height).toBe(138)
  expect(chart.overrideYAxis).toHaveBeenCalledWith(expect.objectContaining({ paneId: 'tsp_vol', gap: { top: 54, bottom: 4 } }))
  await act(async () => pane.querySelector('button')!.click())
  expect(change).toHaveBeenCalledOnce()
  await render({ activeIndicators: ['macd'], volumeCompareControls })
  expect(pane.textContent).toBe('')
  await render({ activeIndicators: ['macd', 'vol'], volumeCompareControls })
  expect(pane.textContent).toContain('量能设置')
  expect(engine.init).toHaveBeenCalledOnce()
})

it('日期轴始终排在主图下方，切周期、增删重排副图和关闭缠论后位置不变', async () => {
  const paneOrder = () => Object.entries(state.panes)
    .sort(([, a], [, b]) => a.order! - b.order!)
    .map(([id]) => id)
  await render()
  expect(paneOrder()).toEqual(['candle_pane', 'x_axis_pane'])
  await render({ activeIndicators: ['vol', 'kdj'] })
  expect(paneOrder()).toEqual(['candle_pane', 'x_axis_pane', 'tsp_vol', 'tsp_kdj'])
  await render({ activeIndicators: ['kdj', 'vol'], period: '30m' })
  expect(paneOrder()).toEqual(['candle_pane', 'x_axis_pane', 'tsp_kdj', 'tsp_vol'])
  await render({ activeIndicators: [] })
  expect(paneOrder()).toEqual(['candle_pane', 'x_axis_pane'])
  await render({ chanlunAnalysis: {} as never, chanlunOverlay: { enabled: true } as never })
  expect(host.querySelector('[data-kline-chart]')).not.toBeNull()
  await render({ activeIndicators: ['vol'], chanlunAnalysis: {} as never, chanlunOverlay: { enabled: false } as never })
  expect(paneOrder()).toEqual(['candle_pane', 'x_axis_pane', 'tsp_vol'])
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

it('展开或收起侧栏后等待画布布局，再按新宽度适配默认可见根数', async () => {
  const data = Array.from({ length: 200 }, (_, i) => ({
    ...rows()[0], date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  }))
  await render({ data, visibleBars: 120 })
  chart.setBarSpace.mockClear()
  await act(async () => state.resize?.())
  expect(chart.setBarSpace).not.toHaveBeenCalled()
  state.width = 400
  await act(async () => state.frames.splice(0).forEach(callback => callback(0)))
  expect(chart.setBarSpace).toHaveBeenLastCalledWith((400 - 8) / 120)
})

it('拖动后的副图高度在切周期、指标重排/重开和窄屏布局时保留', async () => {
  const indicators = ['vol', 'etf-swing-v2']
  await render({ activeIndicators: indicators })
  expect(state.panes.tsp_vol).toMatchObject({ height: 112, minHeight: 78 })
  state.panes.tsp_vol.height = 180
  state.panes.tsp_etf_swing_v2.height = 260
  await act(async () => state.handlers.onPaneDrag({ paneId: '' }))
  expect(JSON.parse(localStorage.getItem('stock_preview_sub_chart_heights')!)).toEqual({ vol: 152, 'etf-swing-v2': 220 })
  chart.scrollToRealTime.mockClear()
  await render({ activeIndicators: ['etf-swing-v2', 'vol'], period: '30m', volumeCompare: { enabled: false, days: 3 } })
  expect(state.panes.tsp_vol.height).toBe(180)
  expect(state.panes.tsp_etf_swing_v2.height).toBe(260)
  await render({ activeIndicators: ['etf-swing-v2'], period: '30m' })
  await render({ activeIndicators: indicators, period: '30m' })
  expect(state.panes.tsp_vol.height).toBe(180)
  state.width = 320
  await act(async () => state.resize?.())
  expect(state.panes.tsp_vol.height).toBe(180)
  expect(state.panes.tsp_etf_swing_v2.height).toBe(300)
  expect(state.panes.tsp_etf_swing_v2.minHeight).toBe(130)
  expect(chart.setStyles).toHaveBeenCalledWith(expect.objectContaining({ separator: expect.objectContaining({ size: 4 }) }))
  await act(async () => root.render(null))
  expect(chart.unsubscribeAction).toHaveBeenCalledWith('onPaneDrag', expect.any(Function))
  await render({ activeIndicators: indicators })
  expect(state.panes.tsp_vol.height).toBe(180)
  expect(state.panes.tsp_etf_swing_v2.height).toBe(300)
})

it('损坏或非法的副图高度设置使用默认值', async () => {
  for (const value of [null, [], { vol: -1, 'etf-swing-v2': 'huge', unknown: 400 }, { vol: 1e10 }]) {
    localStorage.setItem('stock_preview_sub_chart_heights', JSON.stringify(value))
    await render({ activeIndicators: ['vol', 'etf-swing-v2'] })
    expect(state.panes.tsp_vol.height).toBe(112)
    expect(state.panes.tsp_etf_swing_v2.height).toBe(240)
    await act(async () => root.render(null))
  }
})

it('恢复较高副图时扩展画布，不挤掉主图', async () => {
  localStorage.setItem('stock_preview_sub_chart_heights', JSON.stringify({ vol: 600, 'etf-swing-v2': 700 }))
  await render({ activeIndicators: ['vol', 'etf-swing-v2'] })
  expect((host.querySelector('[data-kline-chart]')?.parentElement as HTMLElement).style.height).toBe('1540px')
  expect(state.panes.candle_pane.minHeight).toBe(120)
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

it('六个自定义公式迁入同一个新引擎，移除后不残留；隐藏日期共用新引擎', async () => {
  await render({ activeIndicators: ['angel-devil', 'boll2', 'kd-divergence', 'kd-enhanced', 'etf-swing-v2', 'bull-bear-trend-v2'] })
  expect(host.querySelector('[data-legacy-chart]')).toBeNull()
  expect(state.indicators.map(i => i.name)).toEqual(['TSP_ANGEL_DEVIL', 'TSP_BOLL2', 'TSP_KD_DIVERGENCE', 'TSP_KD_ENHANCED', 'TSP_ETF_SWING_V2', 'TSP_BULL_BEAR_TREND_V2'])
  expect(chart.setPaneOptions).toHaveBeenCalledWith(expect.objectContaining({ id: 'tsp_kd_enhanced', order: 2 }))
  expect(chart.setPaneOptions).toHaveBeenCalledWith(expect.objectContaining({ id: 'tsp_bull_bear_trend_v2', order: 4 }))
  await render({ activeIndicators: ['bull-bear-trend-v2'], period: '30m' })
  expect(chart.overrideIndicator).toHaveBeenCalledWith(expect.objectContaining({ name: 'TSP_BULL_BEAR_TREND_V2', extendData: { period: '30m' } }))
  await render({ activeIndicators: ['vol', 'macd'] })
  expect(state.indicators.map(i => i.name)).toEqual(['TSP_MA', 'TSP_VOL', 'TSP_MACD'])
  expect(host.querySelector('[data-kline-chart]')).not.toBeNull()
  expect(engine.init).toHaveBeenCalledOnce()
  await render({ hideCurrentDate: true })
  expect(host.querySelector('[data-kline-chart]')).not.toBeNull()
  expect(host.textContent).not.toContain(rows()[0].date)
  expect(host.textContent).not.toContain(rows().at(-1)!.date)
})

it('天使魔鬼按原公式显示空心多头/实心空头，主图信息随悬停更新并在移除时恢复普通MA', async () => {
  const data = [...Array<number>(30).fill(100), 110, 112, 90, 88, 105].map((close, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    open: close + 1, close, high: close + 2, low: close - 2, ma5: 999,
  }))
  await render({ data, activeIndicators: ['angel-devil', 'boll2'] })
  const barStyle = chart.setStyles.mock.calls.at(-1)![0].candle.bar
  expect(barStyle({ current: state.bars[30] })).toMatchObject({ color: 'transparent', borderColor: '#FF0000' })
  expect(barStyle({ current: state.bars[32] })).toMatchObject({ color: '#00FFFF', borderColor: '#00DDFF' })
  expect(host.textContent).toContain('MA13:')
  expect(host.textContent).not.toContain('MA5:999')
  await act(async () => state.handlers.onCrosshairChange({ dataIndex: 20 }))
  expect(host.textContent).toContain('boll2 BOLL:100.00')
  await render({ data, activeIndicators: [] })
  expect(host.textContent).not.toContain('MA13:')
  expect(host.textContent).not.toContain('boll2')
  expect(chart.setStyles.mock.calls.at(-1)![0].candle.bar({ current: state.bars[30] })).toMatchObject({ color: '#2D9B65' })
})

it('30分钟切换和ETF三位价格保留', async () => {
  await render({ assetType: 'etf', data: rows(0.497) })
  expect(chart.setSymbol).toHaveBeenCalledWith(expect.objectContaining({ pricePrecision: 3 }))
  expect(host.textContent).toContain('0.497')
  await render({ assetType: 'etf', period: '30m', data: [{ ...rows(0.497)[0], date: '2026-10-01 10:00' }] })
  expect(chart.setPeriod).toHaveBeenLastCalledWith({ span: 30, type: 'minute' })
  expect(state.bars[0].timestamp).toBe(Date.parse('2026-10-01T10:00:00+08:00'))
})

it('缠论和隐藏日期切换不重建图表，调试不泄露信息栏和十字线日期', async () => {
  const chanlunAnalysis = emptyChanlunAnalysis()
  await render({ chanlunAnalysis, activeIndicators: ['vol', 'kdj'] })
  await render({ chanlunAnalysis, chanlunOverlay: { enabled: true, fractals: true, strokes: true, segments: true, centers: true, candidates: true, divergences: true }, activeIndicators: ['vol', 'kdj'], hideCurrentDate: true })
  expect(engine.init).toHaveBeenCalledOnce()
  expect(engine.dispose).not.toHaveBeenCalled()
  expect(host.textContent).not.toMatch(/2026-10-\d\d/)
  expect(chart.setStyles).toHaveBeenLastCalledWith(expect.objectContaining({
    xAxis: expect.objectContaining({ tickText: expect.objectContaining({ show: false }) }),
    crosshair: expect.objectContaining({ vertical: expect.objectContaining({ text: expect.objectContaining({ show: false }) }) }),
  }))
  await render({ chanlunAnalysis, hideCurrentDate: false, activeIndicators: ['vol', 'kdj'] })
  expect(host.textContent).toContain(rows().at(-1)!.date)
  expect(engine.init).toHaveBeenCalledOnce()
})

it('缠论切换不重置缩放或丢失副图；价位高亮更新原覆盖物、关组后清除', async () => {
  const analysis = emptyChanlunAnalysis()
  analysis.fractals = [{ type: 'bottom', date: rows()[1].date, price: 9, confirmedAt: rows()[2].date, mergedIndex: 1, sourceIndex: 1, confirmedSourceIndex: 2 }]
  const config = { enabled: true, fractals: true, strokes: false, segments: false, centers: false, candidates: false, divergences: false }
  const data = rows(), activeIndicators = ['vol', 'kdj']
  await render({ data, activeIndicators, chanlunAnalysis: analysis, chanlunOverlay: config, priceLines: [{ value: 20, key: 'sr', label: '压力' }] })
  expect(state.overlays.some(overlay => overlay.groupId === 'tsp-chanlun')).toBe(true)
  chart.resetData.mockClear(); chart.scrollToRealTime.mockClear()
  await render({ data, activeIndicators, chanlunAnalysis: analysis, chanlunOverlay: { ...config, enabled: false }, priceLines: [{ value: 20, key: 'sr', label: '压力' }], highlightedKey: 'sr' })
  expect(state.overlays.filter(overlay => overlay.groupId === 'tsp-chanlun')).toEqual([])
  expect(chart.overrideOverlay).toHaveBeenCalledWith(expect.objectContaining({ extendData: expect.objectContaining({ highlighted: true }) }))
  expect(chart.resetData).not.toHaveBeenCalled()
  expect(chart.scrollToRealTime).not.toHaveBeenCalled()
  expect(state.indicators.map(indicator => indicator.name)).toEqual(['TSP_MA', 'TSP_VOL', 'TSP_KDJ'])
  await render({ data, activeIndicators })
  expect(state.overlays.filter(overlay => overlay.groupId === 'tsp-levels')).toEqual([])
})

it('分析图范围条与画布缩放联动，拖动端点不重建图表', async () => {
  await render({ showRangeSelector: true, priceLabelWidth: 144 })
  await act(async () => state.handlers.onVisibleRangeChange({ from: 1, to: 3 }))
  const start = host.querySelector<HTMLInputElement>('[aria-label="可见起始K线"]')!
  const end = host.querySelector<HTMLInputElement>('[aria-label="可见结束K线"]')!
  expect(start.value).toBe('1')
  expect(end.value).toBe('3')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(end, '4')
    end.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(chart.scrollToDataIndex).toHaveBeenLastCalledWith(3)
  expect(chart.scrollByDistance).toHaveBeenLastCalledWith(-144)
  expect(engine.init).toHaveBeenCalledOnce()
})

it('新增内置主图与副图直接调用引擎，不覆盖TSP公式，关闭后移除', async () => {
  await render({ activeIndicators: ['macd', 'builtin-ema', 'builtin-sar', 'builtin-cci', 'builtin-obv'] })
  expect(state.indicators.map(indicator => indicator.name)).toEqual(['TSP_MA', 'TSP_MACD', 'EMA', 'SAR', 'CCI', 'OBV'])
  expect(chart.createIndicator).toHaveBeenCalledWith({ name: 'EMA', paneId: 'candle_pane' }, true)
  expect(chart.createIndicator).toHaveBeenCalledWith({ name: 'CCI', paneId: 'tsp_builtin_cci' }, true)
  expect(state.panes.tsp_builtin_cci).toMatchObject({ minHeight: 78 })
  await render({ activeIndicators: ['macd'] })
  expect(state.indicators.map(indicator => indicator.name)).toEqual(['TSP_MA', 'TSP_MACD'])
  expect(engine.init).toHaveBeenCalledOnce()
})


it('MA开关同时控制曲线和信息栏，天使魔鬼优先且移除后遵循MA选择', async () => {
  const data = rows().map(row => ({ ...row, ma5: 10.25, ma10: 10.5, ma20: 10.75, ma60: 11 }))
  await render({ data, showMA: true })
  expect(state.indicators.some(indicator => indicator.name === 'TSP_MA')).toBe(true)
  expect(host.textContent).toContain('MA5:10.25')
  await render({ data, showMA: false, activeIndicators: ['ma', 'vol'] })
  expect(state.indicators.map(indicator => indicator.name)).toEqual(['TSP_VOL'])
  expect(host.textContent).not.toContain('MA5:10.25')
  await render({ data, showMA: true, activeIndicators: ['angel-devil'] })
  expect(state.indicators.map(indicator => indicator.name)).toEqual(['TSP_ANGEL_DEVIL'])
  await render({ data, showMA: false, activeIndicators: ['angel-devil'] })
  await render({ data, showMA: false, activeIndicators: [] })
  expect(state.indicators).toEqual([])
  await render({ data, showMA: true, activeIndicators: [] })
  expect(state.indicators.map(indicator => indicator.name)).toEqual(['TSP_MA'])
  expect(engine.init).toHaveBeenCalledOnce()
})

it('点击MA数值只切换对应曲线，保留数值入口，可全部隐藏再恢复，不重置图表', async () => {
  const data = rows().map(row => ({ ...row, ma5: 10.25, ma10: 10.5, ma20: 10.75, ma60: 11 }))
  await render({ data })
  chart.resetData.mockClear(); chart.scrollToRealTime.mockClear()
  const toggle = async (label: string) => {
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click())
  }
  await toggle('隐藏 MA10')
  expect(chart.overrideIndicator).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'TSP_MA', figures: expect.any(Array) }))
  expect(chart.overrideIndicator.mock.calls.at(-1)![0].figures.map((figure: { key: string }) => figure.key)).toEqual(['ma5', 'ma20', 'ma60'])
  expect(host.querySelector('[aria-label="显示 MA10"]')?.getAttribute('aria-pressed')).toBe('false')
  expect(host.textContent).toContain('MA10:10.50')
  for (const period of [5, 20, 60]) await toggle(`隐藏 MA${period}`)
  expect(chart.overrideIndicator.mock.calls.at(-1)![0].figures).toEqual([])
  await toggle('显示 MA10')
  expect(chart.overrideIndicator.mock.calls.at(-1)![0].figures.map((figure: { key: string }) => figure.key)).toEqual(['ma10'])
  expect(chart.resetData).not.toHaveBeenCalled()
  expect(chart.scrollToRealTime).not.toHaveBeenCalled()
  await render({ data, symbol: 'B', period: '1w' })
  expect(host.querySelector('[aria-label="隐藏 MA10"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="显示 MA5"]')).not.toBeNull()
  expect(engine.init).toHaveBeenCalledOnce()
})
