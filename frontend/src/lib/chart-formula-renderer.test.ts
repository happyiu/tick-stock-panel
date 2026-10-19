// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { formulaContext, serverFormulaTemplate, serverFormulaDraw, serverFormulaFigures } from './chart-formula-renderer'
import type { ChartIndicatorResult } from './api'
import type { Indicator, KLineData } from 'klinecharts'
const packet: ChartIndicatorResult = { name: '测试', pane: 'sub', revision: 1, dates: ['2026-10-16'], rows: [{ line: 10, cond: 1, from: 3, to: 20, width: 8, hollow: 0 }], figures: [{ key: 'line', color: '#FF0000', width: 2, dash: false, hidden: false }], drawings: [{ key: '__draw', kind: 'STICKLINE', color: '#FF0000', width: 1, dash: false, hidden: false, fields: [[0,'cond'],[1,'from'],[2,'to'],[3,'width'],[4,'hollow']], text: [] }] }
it('日期对齐上下文经过图表库的JSON式克隆后仍能读取，且不重算金融公式', async () => {
  const context = JSON.parse(JSON.stringify(formulaContext('test', packet, true, 1)))
  const template = serverFormulaTemplate('TEST')
  const rows = await template.calc([{ timestamp: 1, open: 1, high: 1, low: 1, close: 1, date: '2026-10-16' }] as KLineData[], { extendData: context } as Indicator<Record<string, number | null>, number, typeof context>)
  expect(rows[0].line).toBe(10)
  expect(serverFormulaFigures(packet)[0].key).toBe('line')
})
it('柱线保留原公式的上下端、宽度与颜色', () => {
  const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(), measureText: () => ({ width: 10 }) }
  serverFormulaDraw({ ctx, chart: { getVisibleRange: () => ({ from: 0, to: 1 }), getBarSpace: () => ({ bar: 20 }) }, bounding: { width: 200, height: 120 },
    xAxis: { convertToPixel: () => 30 }, yAxis: { convertToPixel: (v: number) => 110-v }, indicator: { result: packet.rows, extendData: formulaContext('test', packet, true, 1) },
  } as unknown as Parameters<typeof serverFormulaDraw>[0])
  expect(ctx.fillRect).toHaveBeenCalledWith(10,90,40,17)
})

it('图表上下文只携带一份数值，支持压缩后的常量绘图参数', () => {
  const compact = { ...packet, drawings: [{ ...packet.drawings[0], fields: [[0,'cond'],[1,'from'],[2,'to']] as [number,string][], constants: [[3,8],[4,0]] as [number,number][] }] }
  const context = formulaContext('test', compact, true, 1)
  expect(context.packet).not.toHaveProperty('rows')
  expect(context.packet).not.toHaveProperty('dates')
  const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(), measureText: () => ({ width: 10 }) }
  serverFormulaDraw({ ctx, chart: { getVisibleRange: () => ({ from: 0, to: 1 }), getBarSpace: () => ({ bar: 20 }) }, bounding: { width: 200, height: 120 },
    xAxis: { convertToPixel: () => 30 }, yAxis: { convertToPixel: (v: number) => 110-v }, indicator: { result: compact.rows, extendData: context },
  } as unknown as Parameters<typeof serverFormulaDraw>[0])
  expect(ctx.fillRect).toHaveBeenCalledWith(10,90,40,17)
})

it('成交量提示只访问当前K线，不遍历整段历史', () => {
  const bars = new Array(1000)
  Object.defineProperty(bars, 0, { get: () => { throw new Error('不应访问其他K线') } })
  bars[999] = { volume: 100 }
  const context = formulaContext('vol', packet, true, 1)
  const result = serverFormulaTemplate('VOL').createTooltipDataSource?.({
    chart: { getDataList: () => bars }, crosshair: { dataIndex: 999 },
    indicator: { extendData: context, result: { 999: { vol_ma5: 50, vol_ma10: 40, volume_ratio: 2 } } },
  } as unknown as Parameters<NonNullable<ReturnType<typeof serverFormulaTemplate>['createTooltipDataSource']>>[0])
  expect(result?.legends?.at(-1)?.value).toBe('2.00x')
})

it.each([{ bar: 20, gapBar: 14 }, { bar: 6, gapBar: 3 }])('成交量柱沿用原生柱宽并随缩放保留间隔 $bar', space => {
  const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(), measureText: () => ({ width: 10 }) }
  serverFormulaDraw({ ctx, chart: { getVisibleRange: () => ({ from: 0, to: 1 }), getBarSpace: () => space }, bounding: { width: 200, height: 120 },
    xAxis: { convertToPixel: () => 30 }, yAxis: { convertToPixel: (v: number) => 110-v }, indicator: { result: packet.rows, extendData: formulaContext('vol', packet, false, 1) },
  } as unknown as Parameters<typeof serverFormulaDraw>[0])
  expect(ctx.fillRect).toHaveBeenCalledWith(30-space.gapBar/2,90,space.gapBar,17)
})

it.each([40, 200])('天使魔鬼文字跟随箭头，缩放后仍保持固定像素间距 %s', arrowY => {
  const signals: ChartIndicatorResult = { ...packet, pane: 'main', drawings: [
    { ...packet.drawings[0], key: 'up', kind: 'DRAWICON', fields: [], constants: [[2, 1]], text: [] },
    { ...packet.drawings[0], key: 'down', kind: 'DRAWICON', fields: [], constants: [[2, 2]], text: [] },
    { ...packet.drawings[0], key: 'buyText', kind: 'DRAWTEXT', fields: [], text: [[2, '进攻']] },
    { ...packet.drawings[0], key: 'sellText', kind: 'DRAWTEXT', fields: [], text: [[2, '撤退']] },
  ] }
  const figures = serverFormulaFigures(signals, 'angel-devil')
  const attrs = (key: string) => (figures.find(f => f.key === key)!.attrs as Function)({
    coordinate: { current: { x: 25, up: arrowY, down: arrowY, buyText: 500, sellText: 0 } }, data: { current: {} },
  })
  expect(attrs('buyText')).toMatchObject({ x: 25, y: arrowY + 9, align: 'center', baseline: 'top', text: '进攻' })
  expect(attrs('sellText')).toMatchObject({ x: 25, y: arrowY - 9, align: 'center', baseline: 'bottom', text: '撤退' })
  const original = serverFormulaFigures(signals)
  expect((original.find(f => f.key === 'buyText')!.attrs as Function)({ coordinate: { current: { x: 25, buyText: 500 } }, data: { current: {} } })).toMatchObject({ y: 500 })
})
