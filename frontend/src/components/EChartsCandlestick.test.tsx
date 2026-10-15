// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EChartsCandlestick, type OHLC } from './EChartsCandlestick'

const chart = vi.hoisted(() => ({
  handlers: {} as Record<string, (event?: any) => void>,
  setOption: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  dispatchAction: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  getZr: () => ({ on: vi.fn(), off: vi.fn() }),
  getOption: () => ({ dataZoom: [{ start: 0, end: 100 }] }),
  containPixel: () => false,
  convertFromPixel: () => [0, 0],
}))

vi.mock('echarts', () => ({ init: () => chart }))

// 超过 COMPACT_THRESHOLD(60): 切标的后 dataZoom 一响就会走紧凑态转换, 进而重写 markPoint
const DAYS = Array.from({ length: 62 }, (_, i) =>
  new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10))
const rows = (base: number): OHLC[] =>
  DAYS.map(date => ({ date, open: base, high: base + 1, low: base - 1, close: base, volume: 1 }))

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  chart.handlers = {}
  chart.setOption.mockClear()
  chart.on.mockImplementation((name: string, callback: (event?: any) => void) => {
    chart.handlers[name] = callback
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

/** 最后一次 setOption 里 K 线的 markPoint (买卖箭头来源) */
function lastMarkPoint(): string {
  const option = chart.setOption.mock.calls.at(-1)?.[0] as any
  const k = option?.series?.find((s: any) => s.name === 'K')
  return JSON.stringify(k?.markPoint ?? null)
}

/** 模拟竖虚线命中某根 K 线 (鼠标在数据区内移动时 echarts 派发的事件) */
async function hoverCandle(index: number) {
  await act(async () => { chart.handlers.updateAxisPointer?.({ axesInfo: [{ value: index }] }) })
}

it('切标的后响应 dataZoom 仍用当前标的的买卖标记, 不回退到上一只', async () => {
  const render = async (symbol: string, data: OHLC[], markerLabel: string, markerDate: string) => {
    await act(async () => root.render(
      <EChartsCandlestick
        data={data}
        markers={[{ date: markerDate, kind: 'buy', label: markerLabel }]}
        symbol={symbol}
        height={400}
        showInfoBar={false}
        visibleBars="all"
        activeIndicators={['vol']}
      />,
    ))
  }

  await render('600000', rows(10), 'A-BUY', DAYS[10])
  await render('000001', rows(100), 'B-SELL', DAYS[20])

  // 切换标的后图表实例被复用, dataZoom 监听仍是最初注册的那个; 首次 setOption 已是当前标的
  expect(lastMarkPoint()).toContain('B-SELL')

  await act(async () => { chart.handlers.dataZoom?.() })

  expect(lastMarkPoint()).toContain('B-SELL')
  expect(lastMarkPoint()).not.toContain('A-BUY')
})

it('切股后鼠标未离开图表, 竖虚线重新命中即恢复「至今/周期」', async () => {
  const render = async (symbol: string) => {
    await act(async () => root.render(
      <EChartsCandlestick data={rows(10)} symbol={symbol} height={400} visibleBars="all" />,
    ))
  }

  await render('600000')
  const surface = host.firstElementChild as HTMLElement
  await act(async () => { surface.dispatchEvent(new MouseEvent('mouseenter')) })
  await hoverCandle(30)
  expect(host.textContent).toContain('至今')

  // 切股: 上一只的悬停上下文作废, 清掉「至今/周期」
  await render('000001')
  expect(host.textContent).not.toContain('至今')

  // 鼠标没离开图表区 (只是切股), 竖虚线重新命中即恢复, 不靠 mouseenter
  await hoverCandle(20)
  expect(host.textContent).toContain('至今')
  expect(host.textContent).toContain('周期')

  // 移出图表区 → 重新收起
  await act(async () => { surface.dispatchEvent(new MouseEvent('mouseleave')) })
  expect(host.textContent).not.toContain('至今')
})

const formulaData = (): OHLC[] => [...Array<number>(30).fill(100), 110, 112, 90, 88, 105].map((close, index) => ({
  date: DAYS[index], open: close + 1, high: close + 2, low: close - 2, close,
  ma5: close, ma10: close, ma20: close, ma60: close,
}))

function subInfo(key: string): HTMLElement {
  return host.querySelector(`[data-sub-info="${key}"]`) as HTMLElement
}

function fullOption(): any {
  return chart.setOption.mock.calls.findLast(call => call[0]?.series?.some((s: any) => s.type === 'candlestick'))?.[0]
}

it('主图公式替换默认均线，按多空关系着色，箭头文字使用原公式坐标', async () => {
  const data = formulaData()
  await act(async () => root.render(
    <EChartsCandlestick data={data} activeIndicators={['angel-devil']} showMarkers={false} visibleBars="all" />,
  ))
  const option = fullOption()
  const k = option.series.find((s: any) => s.name === 'K')
  expect(k.large).toBe(false)
  expect(k.data[30].itemStyle).toMatchObject({ color: 'transparent', color0: 'transparent', borderColor: '#FF0000' })
  expect(k.data[32].itemStyle).toMatchObject({ color: '#00FFFF', color0: '#00FFFF' })
  expect(option.series.find((s: any) => s.name === 'MA13').data[30]).toBeCloseTo(100 + 10 / 13, 10)
  expect(option.series.some((s: any) => s.name === 'MA10')).toBe(false)
  expect(option.series.some((s: any) => s.name === 'MA60')).toBe(false)
  expect(option.grid).toHaveLength(1)
  expect(option.series.find((s: any) => s.name === '天使魔鬼进攻箭头').data).toEqual([[DAYS[30], 108 * 0.97]])
  expect(option.series.find((s: any) => s.name === '天使魔鬼进攻文字').data).toEqual([[DAYS[30], 108 * 0.92]])
  expect(option.series.find((s: any) => s.name === '天使魔鬼撤退文字').data).toEqual([[DAYS[32], 92 * 1.08]])
  expect(host.textContent).toContain('MA13:')
  expect(host.textContent).not.toContain('MA10:')
})

it('切股、缩放和关闭指标后不会留下旧信号或公式K线样式', async () => {
  await act(async () => root.render(
    <EChartsCandlestick symbol="A" data={formulaData()} activeIndicators={['angel-devil']} visibleBars="all" />,
  ))
  await act(async () => root.render(
    <EChartsCandlestick symbol="B" data={rows(3)} activeIndicators={['angel-devil']} visibleBars="all" />,
  ))
  await act(async () => chart.handlers.dataZoom?.())
  expect(fullOption().series.find((s: any) => s.name === '天使魔鬼进攻文字').data).toEqual([])
  await act(async () => root.render(
    <EChartsCandlestick symbol="B" data={formulaData()} activeIndicators={[]} visibleBars="all" />,
  ))
  expect(Array.isArray(fullOption().series.find((s: any) => s.name === 'K').data[30])).toBe(true)
  expect(fullOption().series.some((s: any) => s.name.startsWith('天使魔鬼'))).toBe(false)
  expect(host.textContent).toContain('MA10:')
})

it('移除结构价位带后仍保留调用方传入的监控或回测价格线', async () => {
  await act(async () => root.render(
    <EChartsCandlestick data={formulaData()} activeIndicators={['angel-devil']}
      priceLines={[{ value: 104, label: '监控价格', color: '#60A5FA' }]} />,
  ))
  const k = fullOption().series.find((s: any) => s.name === 'K')
  expect(k.markLine.data).toContainEqual(expect.objectContaining({
    yAxis: 104, label: expect.objectContaining({ formatter: '监控价格' }),
  }))
  expect(k.markArea).toBeUndefined()
})

it('boll2按原公式画三条主图轨道，信息栏随十字线更新，切股和关闭不残留', async () => {
  const data = DAYS.map((date, index) => ({ date, open: index + 1, high: index + 2, low: index, close: index + 1 }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} activeIndicators={['boll2']} visibleBars="all" />,
  ))
  let option = fullOption()
  expect(option.grid).toHaveLength(1)
  expect(option.series.find((s: any) => s.name === 'boll2 BOLL').data[20]).toBe(10.5)
  expect(option.series.find((s: any) => s.name === 'boll2 UB').data[38]).toBe('-')
  expect(option.series.find((s: any) => s.name === 'boll2 UB').data[39]).toBe(48.5)
  expect(option.series.find((s: any) => s.name === 'boll2 LB').data[39]).toBe(10.5)
  expect(option.series.find((s: any) => s.name === 'boll2 UB').lineStyle.color).toBe('#FFFF00')
  expect(option.series.find((s: any) => s.name === 'boll2 LB').lineStyle.color).toBe('#FF00FF')
  await hoverCandle(39)
  expect(host.textContent).toContain('boll2 BOLL:29.50')
  expect(host.textContent).toContain('UB:48.50')
  await act(async () => root.render(
    <EChartsCandlestick symbol="B" data={rows(3)} activeIndicators={['boll2', 'angel-devil']} visibleBars="all" />,
  ))
  await act(async () => chart.handlers.dataZoom?.())
  option = fullOption()
  expect(option.series.find((s: any) => s.name === 'boll2 UB').data[39]).toBe(3)
  expect(option.series.some((s: any) => s.name === 'MA13')).toBe(true)
  await act(async () => root.render(
    <EChartsCandlestick symbol="B" data={rows(3)} activeIndicators={[]} visibleBars="all" />,
  ))
  expect(fullOption().series.some((s: any) => s.name.startsWith('boll2'))).toBe(false)
  expect(host.textContent).not.toContain('boll2')
})

it('KD背离有独立副图、参考线、柱线与背离标注，十字线使用当前行计算结果', async () => {
  const closes = [...Array<number>(12).fill(50), 100, 5, 0, 30, 20, 20, 10, 5, 100, 90, 5, 95, 70, 0, 0, 5, 20, 20, 90, 95, 0, 90, 20]
  const data = closes.map((close, index) => ({ date: DAYS[index], open: close, high: 100, low: 0, close, volume: 1 }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} activeIndicators={['vol', 'kd-divergence', 'boll2']} visibleBars="all" />,
  ))
  const option = fullOption()
  expect(option.grid).toHaveLength(3)
  const k = option.series.find((s: any) => s.name === 'KD背离 K')
  expect(k).toMatchObject({ xAxisIndex: 2, yAxisIndex: 2 })
  expect(k.data[12]).toBe(62.5)
  expect(k.markLine.data.map((line: any) => line.yAxis)).toEqual([90, 50, 10])
  expect(k.markLine.data.every((line: any) => line.lineStyle.type === 'solid')).toBe(true)
  expect(option.series.find((s: any) => s.name === 'KD背离 加仓').data).toEqual([[DAYS[30], 24.337663650512695 - 5]])
  expect(option.series.find((s: any) => s.name === 'KD背离 减仓').data[0][0]).toBe(DAYS[34])
  const bottomLine = option.series.find((s: any) => s.name === 'KD背离 底背离连线').markLine.data[0]
  expect(bottomLine[0].coord[0]).toBe(DAYS[21])
  expect(bottomLine[1].coord[0]).toBe(DAYS[30])
  const sticks = option.series.find((s: any) => s.name === 'KD背离 柱线')
  expect(sticks.data.some((item: any) => item.value[0] === 12 && item.itemStyle.color === '#FF0000')).toBe(true)
  const values = [5, 80, 90, 2.5]
  expect(sticks.renderItem({ coordSys: { x: 0, y: 0, width: 100, height: 110 } }, {
    value: (index: number) => values[index], coord: ([x, y]: number[]) => [x * 10, 110 - y],
    size: () => [10, 0], visual: () => '#00FF00',
  })).toEqual({ type: 'rect', shape: { x: 46.875, y: 20, width: 6.25, height: 10 }, style: { fill: '#00FF00' } })
  await hoverCandle(30)
  expect(subInfo('kd-divergence').textContent).toContain('底背离:1')
  await act(async () => root.render(
    <EChartsCandlestick symbol="B" data={rows(3)} activeIndicators={['kd-divergence']} visibleBars="all" />,
  ))
  await hoverCandle(30)
  expect(subInfo('kd-divergence').textContent).toContain('K:50.00')
  await act(async () => root.render(<EChartsCandlestick data={data} activeIndicators={[]} />))
  expect(fullOption().grid).toHaveLength(1)
  expect(fullOption().series.some((item: any) => item.name.startsWith('KD背离'))).toBe(false)
})

it('增强版与原KD分图共存，白色粗K黄D，分型标记只画在确认根且不继承旧版连线', async () => {
  const data = Array.from({ length: 70 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    open: 110, high: 200, low: i === 20 ? 80 : i === 25 ? 70 : 100,
    close: i === 20 ? 90 : i >= 23 ? 170 : 110,
  }))
  await act(async () => root.render(
    <EChartsCandlestick data={data} activeIndicators={['kd-divergence', 'kd-enhanced']} visibleBars="all" />,
  ))
  const option = fullOption()
  expect(option.grid).toHaveLength(3)
  expect(option.series.find((s: any) => s.name === 'K/D精准背离增强版 K')).toMatchObject({
    xAxisIndex: 2, yAxisIndex: 2, lineStyle: { color: '#FFFFFF', width: 2 },
  })
  expect(option.series.find((s: any) => s.name === 'K/D精准背离增强版 D').lineStyle.color).toBe('#FFFF00')
  expect(option.series.find((s: any) => s.name === 'KD背离 K').lineStyle.color).toBe('#FFFF00')
  expect(option.series.find((s: any) => s.name === 'K/D精准背离增强版 底背离').data).toEqual([[data[27].date, 18]])
  expect(option.series.some((s: any) => s.name === 'K/D精准背离增强版 底背离连线')).toBe(false)
  expect(option.series.find((s: any) => s.name === 'K/D精准背离增强版 柱线').data.every((item: any) => item.value[3] === 2)).toBe(true)
  for (const [label, y] of [['顶背离', 82], ['超卖金叉', 30], ['超买死叉', 70], ['试仓', 40], ['减仓', 60]] as const) {
    const series = option.series.find((s: any) => s.name === `K/D精准背离增强版 ${label}`)
    expect(series).toBeDefined()
    expect(series.data.every((point: any) => point[1] === y)).toBe(true)
  }
  const flat = data.map(row => ({ ...row, high: 10, low: 10, close: 10 }))
  await act(async () => root.render(
    <EChartsCandlestick symbol="B" data={flat} activeIndicators={['kd-divergence', 'kd-enhanced']} visibleBars="all" />,
  ))
  await hoverCandle(15)
  expect(subInfo('kd-enhanced').textContent).toContain('K:50.00')
  expect(subInfo('kd-divergence').textContent).toContain('K:—')
  await act(async () => root.render(<EChartsCandlestick data={data} activeIndicators={['kd-divergence']} />))
  expect(fullOption().grid).toHaveLength(2)
  expect(fullOption().series.some((s: any) => s.name.startsWith('K/D精准背离增强版'))).toBe(false)
})

it('ETF波段操盘副图展示趋势柱和六类标注，单行分组说明不遮挡相邻副图，防守参考不画线', async () => {
  const data = Array.from({ length: 80 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    open: i + 0.9, close: i + 1, high: i + 2, low: i, volume: 100,
  }))
  data[66].close = 67.5
  await act(async () => root.render(
    <EChartsCandlestick data={data} activeIndicators={['vol', 'etf-swing-v2', 'kd-enhanced']} visibleBars="all" />,
  ))
  const option = fullOption()
  expect(option.grid).toHaveLength(4)
  expect(option.grid[2].top - option.grid[1].top - option.grid[1].height).toBe(20)
  expect(option.grid[3].top - option.grid[2].top - option.grid[2].height).toBe(20)
  const strength = option.series.find((s: any) => s.name === 'ETF波段操盘V2 趋势强度')
  expect(strength).toMatchObject({ xAxisIndex: 2, yAxisIndex: 2, lineStyle: { color: '#FFFFFF', width: 2 } })
  expect(option.series.find((s: any) => s.name === 'ETF波段操盘V2 慢速线').lineStyle).toMatchObject({ color: '#FFFF00', width: 1 })
  const columns = option.series.find((s: any) => s.name === 'ETF波段操盘V2 趋势柱')
  expect(columns.data[65]).toMatchObject({ value: 90, itemStyle: { color: '#669900' } })
  expect(columns.data[66].itemStyle.color).toBe('#CC66FF')
  expect(strength.markLine.data.map((s: any) => s.yAxis)).toEqual([20, 50, 80])
  expect(strength.markLine.data.every((s: any) => s.lineStyle.type === 'dotted')).toBe(true)
  expect(option.series.find((s: any) => s.name === 'ETF波段操盘V2 高位观察').data).toEqual([[data[65].date, 90]])
  for (const text of ['底部观察', '试仓', '加仓', '高位观察', '减仓', '退出预警']) {
    expect(option.series.find((s: any) => s.name === `ETF波段操盘V2 ${text}`).label.formatter).toBe(text)
  }
  expect(option.series.some((s: any) => s.name.includes('防守参考'))).toBe(false)
  await hoverCandle(65)
  expect(subInfo('etf-swing-v2').textContent).toContain('高位条件数:4')
  expect(subInfo('etf-swing-v2').textContent).toContain('量比参考:1.00x')
  expect(subInfo('etf-swing-v2').textContent).toContain('防守参考:—')
  const header = subInfo('etf-swing-v2')
  expect(header.querySelectorAll('[data-sub-info-group]')).toHaveLength(3)
  expect((header.firstElementChild as HTMLElement).style.whiteSpace).toBe('nowrap')
  expect((header.firstElementChild as HTMLElement).style.gap).toBe('24px')
  expect(header.className).toContain('overflow-x-auto')
  const navigate = vi.fn()
  window.addEventListener('keydown', navigate)
  header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  window.removeEventListener('keydown', navigate)
  expect(navigate).not.toHaveBeenCalled()
  header.scrollLeft = 100
  await hoverCandle(66)
  expect(subInfo('etf-swing-v2')).toBe(header)
  expect(header.scrollLeft).toBe(100)
  const flat = data.map(row => ({ ...row, open: 3, high: 3, low: 3, close: 3 }))
  await act(async () => root.render(
    <EChartsCandlestick symbol="B" data={flat} activeIndicators={['etf-swing-v2']} visibleBars="all" />,
  ))
  await act(async () => chart.handlers.dataZoom?.())
  expect(fullOption().series.find((s: any) => s.name === 'ETF波段操盘V2 高位观察').data).toEqual([])
  await hoverCandle(65)
  expect(subInfo('etf-swing-v2').textContent).toContain('趋势强度:0.00')
  await act(async () => root.render(<EChartsCandlestick data={data} activeIndicators={['vol']} />))
  expect(fullOption().grid).toHaveLength(2)
  expect(subInfo('etf-swing-v2')).toBeNull()
})

it('多空趋势按显式周期重算，保留越界强度和六类信号；辅助价格只进面板', async () => {
  let seed = 42
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296 }
  let previous = 3
  const data = Array.from({ length: 1000 }, (_, i) => {
    const close = previous + (random() - 0.5) * 0.06 + Math.sin(i / 17) * 0.008
    const open = previous + (random() - 0.5) * 0.008
    const high = Math.max(open, close) + random() * 0.012
    const low = Math.min(open, close) - random() * 0.012
    const volume = 1000 * (0.6 + random() * 1.2)
    previous = close
    return { date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10), open, high, low, close, volume }
  })
  const activeIndicators = ['etf-swing-v2', 'bull-bear-trend-v2', 'kd-enhanced']
  const render = async (period: '1d' | '30m' | '1w') => act(async () => root.render(
    <EChartsCandlestick data={data} period={period} activeIndicators={activeIndicators} visibleBars="all" />,
  ))
  await render('1d')
  let option = fullOption()
  expect(option.grid).toHaveLength(4)
  expect(option.grid[2].top - option.grid[1].top - option.grid[1].height).toBe(20)
  expect(option.grid[3].top - option.grid[2].top - option.grid[2].height).toBe(20)
  const strength = option.series.find((s: any) => s.name === '多空趋势V2 多方强度')
  expect(strength).toMatchObject({ xAxisIndex: 2, yAxisIndex: 2, lineStyle: { color: '#FF00FF', width: 2 } })
  expect(strength.data[80]).toBeCloseTo(10.166496234728395, 10)
  expect(strength.data[878]).toBeGreaterThan(100)
  expect(strength.data[500]).toBeLessThan(0)
  expect(option.yAxis[2].min({ min: -3 })).toBe(-10)
  expect(option.yAxis[2].max({ max: 108 })).toBe(110)
  expect(strength.markLine.data.map((s: any) => s.yAxis)).toEqual([80, 50, 20])
  expect(strength.markLine.data.every((s: any) => s.lineStyle.type === 'dashed')).toBe(true)
  const sticks = option.series.find((s: any) => s.name === '多空趋势V2 信号柱')
  expect(sticks.data).toContainEqual({ value: [107, 0, 30, 3], itemStyle: { color: '#FF0000' } })
  expect(sticks.data).toContainEqual({ value: [173, 0, 100, 1], itemStyle: { color: '#FFFFFF' } })
  for (const [text, first, y] of [['底观', 172, 14], ['试仓', 107, 32], ['加仓', 644, 52], ['高观', 122, 84], ['减仓', 150, 66], ['退出', 173, 91]] as const) {
    const series = option.series.find((s: any) => s.name === `多空趋势V2 ${text}`)
    expect(series.data[0]).toEqual([data[first].date, y])
    expect(series.label).toMatchObject({ formatter: text, position: 'left' })
  }
  expect(option.series.some((s: any) => /动态防守价|趋势参考价/.test(s.name))).toBe(false)
  await hoverCandle(80)
  expect(subInfo('bull-bear-trend-v2').textContent).toContain('动态防守价:2.995')
  expect(subInfo('bull-bear-trend-v2').textContent).toContain('信号状态:已就绪')
  await render('30m')
  option = fullOption()
  expect(option.series.find((s: any) => s.name === '多空趋势V2 多方强度').data[80]).toBeCloseTo(6.590073351322218, 10)
  expect(option.series.find((s: any) => s.name === '多空趋势V2 试仓').data[0]).toEqual([data[109].date, 32])
  await hoverCandle(80)
  expect(subInfo('bull-bear-trend-v2').textContent).toContain('多方强度:6.59')
  await render('1w')
  option = fullOption()
  expect(option.series.find((s: any) => s.name === '多空趋势V2 信号柱').data).toEqual([])
  expect(option.series.find((s: any) => s.name === '多空趋势V2 退出').data).toEqual([])
  await hoverCandle(80)
  expect(subInfo('bull-bear-trend-v2').textContent).toContain('信号状态:仅30分钟/日线')
  await act(async () => root.render(<EChartsCandlestick data={data} activeIndicators={['vol']} />))
  expect(fullOption().series.some((s: any) => s.name.startsWith('多空趋势V2'))).toBe(false)
  expect(subInfo('bull-bear-trend-v2')).toBeNull()
})
