import { describe, expect, it } from 'vitest'
import { chartIndicators, classifyBarUpdate, toChartBars, type OHLC } from './kline-chart'

const rows: OHLC[] = Array.from({ length: 12 }, (_, i) => ({
  date: `2026-10-${String(i + 1).padStart(2, '0')}`,
  open: 10, high: 12, low: 9, close: 11, volume: (i + 1) * 100,
  ma5: 123.45, macd_dif: 0.3, macd_dea: 0.2, macd_hist: 0.2,
  rsi_6: 61, rsi_14: 62, rsi_24: 63, boll_upper: 13, boll_lower: 8,
}))

describe('KLineChart 数据边界', () => {
  it('按北京时间映射日期，保留后端指标与成交量单位', () => {
    const bars = toChartBars(rows, 2)
    expect(bars[0].timestamp).toBe(Date.parse('2026-10-01T00:00:00+08:00'))
    expect(bars[0]).toMatchObject({ volume: 100, ma5: 123.45, rsi_14: 62 })
    const ma = chartIndicators.find(d => d.name === 'TSP_MA')!
    expect(ma.calc(bars, {} as never)).toEqual(bars.map(b => ({
      ma5: b.ma5, ma10: undefined, ma20: undefined, ma60: undefined,
    })))
  })

  it('30分钟时间戳和收盘状态不被日线适配截断', () => {
    const bar = toChartBars([{ ...rows[0], date: '2026-10-01 14:30', periodEnd: '2026-10-01 14:59', isClosed: true }], 1)[0]
    expect(bar.timestamp).toBe(Date.parse('2026-10-01T14:30:00+08:00'))
    expect(bar.periodEnd).toBe('2026-10-01 14:59')
    expect(bar.isClosed).toBe(true)
  })

  it('量能倍数仅比较此前 N 个交易日，均量线包含当天', () => {
    const bars = toChartBars(rows, 2)
    expect(bars[1].volume_ratio).toBeUndefined()
    expect(bars[2].volume_ratio).toBe(2)
    expect(bars[4].vol_ma5).toBe(300)
    expect(bars[3].vol_ma5).toBeUndefined()
    expect(toChartBars(rows.map(r => ({ ...r, volume: 0 })), 1)[1].volume_ratio).toBeUndefined()
  })

  it('清理无效蜡烛，按日期排序并去重，不将缺失指标伪装成零', () => {
    const bars = toChartBars([
      rows[1], rows[0], { ...rows[0], close: 15, ma5: null },
      { ...rows[2], high: NaN }, { ...rows[3], date: 'bad-date' },
    ], 1)
    expect(bars.map(b => b.date)).toEqual([rows[0].date, rows[1].date])
    expect(bars[0].close).toBe(15)
    expect(bars[0].ma5).toBeUndefined()
  })

  it('同日替换、跨日追加走增量；历史修订、窗口变化走重置', () => {
    const bars = toChartBars(rows, 1)
    const tick = bars.map(b => ({ ...b }))
    tick[tick.length - 1].close = 12
    expect(classifyBarUpdate(bars, tick)).toBe('tail')
    expect(classifyBarUpdate(bars.slice(0, -1), bars)).toBe('tail')
    expect(classifyBarUpdate(bars, bars.map(b => ({ ...b })))).toBe('none')
    expect(classifyBarUpdate(bars, [{ ...bars[0], ma5: 999 }, ...bars.slice(1)])).toBe('reset')
    expect(classifyBarUpdate(bars, bars.slice(1))).toBe('reset')
    expect(classifyBarUpdate([], bars)).toBe('reset')
  })
})
