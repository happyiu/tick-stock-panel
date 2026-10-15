import { expect, it, vi } from 'vitest'
import type { Indicator } from 'klinecharts'
import { calculateAngelDevil } from './angelDevil'
import { calculateBoll2 } from './boll2'
import { calculateKdDivergence } from './kdDivergence'
import { calculateKdEnhanced } from './kdEnhanced'
import { calculateEtfSwingV2 } from './etfSwingV2'
import { calculateBullBearTrendV2 } from './bullBearTrendV2'
import { toChartBars } from './kline-chart'
import { formulaHeaderHeight, formulaIndicators, type FormulaRow } from './kline-chart-formulas'

const bars = toChartBars(Array.from({ length: 250 }, (_, i) => {
  const close = 12 + Math.sin(i / 7) * 3 + Math.cos(i / 19) * 2
  return { date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: close + Math.sin(i), high: close + 1.2, low: close - 1.3, close, volume: 1000 + i * 37 }
}), 1)
const definition = (key: string) => formulaIndicators.find(i => i.name === `TSP_${key}`)!
const indicator = (period = '1d') => ({ extendData: { period } }) as Indicator<FormulaRow, number, { period: string }>
const drawContext = () => ({
  save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
  moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
  measureText: (text: string) => ({ width: text.length * 6 }),
})

it('六个指标复用原公式，BOLL2延迟与增强版确认位置保持一致', async () => {
  for (const [key, expected] of [
    ['ANGEL_DEVIL', calculateAngelDevil(bars.map(b => b.close))],
    ['BOLL2', calculateBoll2(bars.map(b => b.close))],
    ['KD_DIVERGENCE', calculateKdDivergence(bars)],
    ['KD_ENHANCED', calculateKdEnhanced(bars)],
    ['ETF_SWING_V2', calculateEtfSwingV2(bars)],
    ['BULL_BEAR_TREND_V2', calculateBullBearTrendV2(bars, '1d')],
  ] as const) {
    const actual = await definition(key).calc(bars, indicator())
    for (let i = 0; i < bars.length; i++) {
      for (const [field, value] of Object.entries(expected[i])) {
        if (typeof value === 'number' || value === null) expect(actual[i][field]).toBe(value)
        if (typeof value === 'boolean') expect(actual[i][field]).toBe(Number(value))
      }
    }
    const prefix = await definition(key).calc(bars.slice(0, 120), indicator())
    expect(actual.slice(0, 120)).toEqual(prefix)
  }
})

it('多空趋势按显式周期计算，周线不伪造信号，防守价格不参与副图坐标轴', async () => {
  const def = definition('BULL_BEAR_TREND_V2')
  const daily = await def.calc(bars, indicator())
  const minute = await def.calc(bars, indicator('30m'))
  const weekly = await def.calc(bars, indicator('1w'))
  expect(daily.at(-1)?.dp).not.toBe(minute.at(-1)?.dp)
  expect(def.shouldUpdate!(indicator('1d'), indicator('30m'))).toEqual({ calc: true, draw: true })
  expect(weekly.every(r => !r.supported && !r.trySignal && !r.exitSignal)).toBe(true)
  expect(def.figures?.map(f => f.key)).not.toEqual(expect.arrayContaining(['stop', 'e21', 'rv']))
  let seed = 42, previous = 3
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296 }
  const extended = Array.from({ length: 1000 }, (_, i) => {
    const close = previous + (random() - 0.5) * 0.06 + Math.sin(i / 17) * 0.008
    const open = previous + (random() - 0.5) * 0.008
    const high = Math.max(open, close) + random() * 0.012, low = Math.min(open, close) - random() * 0.012
    const volume = 1000 * (0.6 + random() * 1.2)
    previous = close
    return { timestamp: i, open, close, high, low, volume }
  })
  const raw = await def.calc(extended, indicator())
  expect(raw[878].dp).toBeGreaterThan(100)
  expect(raw[500].dp).toBeLessThan(0)
})

it('天使魔鬼的信号箭头和文字沿用原价格坐标，替换普通MA', async () => {
  const def = definition('ANGEL_DEVIL')
  const result = await def.calc(bars, indicator())
  const index = calculateAngelDevil(bars.map(b => b.close)).findIndex(r => r.signal === 'buy')
  expect(index).toBeGreaterThan(0)
  expect(result[index]).toMatchObject({ attackArrow: bars[index].low * 0.97, attackText: bars[index].low * 0.92 })
  expect(def.figures?.slice(0, 4).map(f => f.key)).toEqual(['ma5', 'ma13', 'ma21', 'ma34'])
})

it('KD柱线保留K到D上下端和宽度，参考线与背离连线在可见范围绘制', () => {
  const ctx = drawContext()
  const rows = [
    { k: 30, d: 40, buy: 0, sell: 0, bottomLineStart: null, topLineStart: null },
    { k: 70, d: 60, buy: 1, sell: 0, bottomLineStart: 0, topLineStart: null },
  ]
  const def = definition('KD_DIVERGENCE')
  const draw = def.draw!
  draw({ ctx, bounding: { width: 200, height: 120 }, indicator: { result: rows },
    chart: { getVisibleRange: () => ({ from: 1, to: 2 }), getBarSpace: () => ({ bar: 20 }) },
    xAxis: { convertToPixel: (i: number) => i * 20 + 10 },
    yAxis: { convertToPixel: (v: number) => 110 - v },
  } as unknown as Parameters<typeof draw>[0])
  expect(ctx.fillRect).toHaveBeenCalledWith(23.75, 40, 12.5, 10)
  expect(ctx.fillRect).toHaveBeenCalledWith(10, 90, 40, 17)
  expect(ctx.moveTo).toHaveBeenCalledWith(10, 70)
  expect(ctx.lineTo).toHaveBeenCalledWith(30, 50)
  expect(ctx.fillText.mock.calls.map(c => c[0])).toEqual(expect.arrayContaining(['逃顶线 90', '中轴线 50', '抄底线 10']))
})

it('密集信号文字避让，左右边缘不显示被截断的半个标签', () => {
  const ctx = drawContext(), def = definition('ETF_SWING_V2'), draw = def.draw!
  draw({ ctx, bounding: { width: 200, height: 120 },
    indicator: { result: Array.from({ length: 5 }, () => ({ k: 60, d: 55, topSignalMark: 90 })) },
    chart: { getVisibleRange: () => ({ from: 0, to: 5 }), getBarSpace: () => ({ bar: 10 }) },
    xAxis: { convertToPixel: (i: number) => i * 10 + 10 },
    yAxis: { convertToPixel: (v: number) => 110 - v },
  } as unknown as Parameters<typeof draw>[0])
  expect(ctx.fillText.mock.calls.map(c => c[0])).toEqual(['高位观察'])
})

it('自定义副图提示保留辅助价格和状态，不能把缺失值写成零', async () => {
  const def = definition('BULL_BEAR_TREND_V2')
  const result = await def.calc(bars, indicator('1w'))
  const tooltip = def.createTooltipDataSource!
  const data = tooltip({ indicator: { result }, crosshair: { dataIndex: 0 },
    chart: { getDataList: () => bars },
  } as unknown as Parameters<typeof tooltip>[0])
  expect(JSON.stringify(data.legends)).toContain('动态防守价')
  expect(JSON.stringify(data.legends)).toContain('仅30分钟/日线')
  expect(JSON.stringify(data.legends)).toContain('—')
})

it('缺失成交量沿用原公式缺失状态，不能被原生量柱的零值替代', async () => {
  const missing = toChartBars(bars.map(({ date, open, high, low, close }) => ({ date, open, high, low, close })), 1)
  expect(missing[100].volume).toBe(0)
  const bull = await definition('BULL_BEAR_TREND_V2').calc(missing, indicator())
  const etf = await definition('ETF_SWING_V2').calc(missing, indicator())
  expect(bull[100]).toMatchObject({ rv: null, obv5: null, trySignal: 0, addSignal: 0 })
  expect(etf[100].volumeRatio).toBeNull()
  expect(formulaHeaderHeight('etf-swing-v2', 320)).toBeGreaterThan(formulaHeaderHeight('etf-swing-v2', 800))
})
