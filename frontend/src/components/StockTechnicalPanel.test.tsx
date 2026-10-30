// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StockTechnicalPanel, type StockTechnicalPanelProps } from './StockTechnicalPanel'
import type { TrendPatternAnalysis, TeachingPattern } from '@/lib/trendPatterns'
const mocks = vi.hoisted(() => ({ analyze: vi.fn(), catalog: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { analyzeTrendPatterns: mocks.analyze, patternCatalog: mocks.catalog } }))
function result(changes: Partial<TrendPatternAnalysis> = {}): TrendPatternAnalysis {
  return {
    version: 'trend-pattern-v1', symbol: '512000.SH', name: '券商ETF', period: '1d', status: 'ok', sampleCount: 250, catalogCount: 84,
    forming: false, lastDate: '2026-10-29', price: .465, prev: .475, issues: [], candles: [['2026-10-29', .474, .474, .464, .465, 100]],
    indicators: { ma: { ma5: [.478], ma10: [.482], ma20: [.488], ma60: [.508] }, macd: { dif: [-.1], dea: [-.05], hist: [-.1] }, rsi: [29], kdj: { k: [20], d: [30], j: [0] }, boll: { mid: [.48], up: [.5], dn: [.46] }, obv: [-10], volMa5: [100], volMa20: [80] },
    trend: { long: { verdict: 'down', window: 120, swingHighs: [.6, .55], swingLows: [.51, .48] }, mid: { verdict: 'down', window: 60, swingHighs: [.55], swingLows: [.48] }, short: { verdict: 'up', window: 20, swingHighs: [], swingLows: [] } },
    swings: { ph: [], pl: [] }, levels: { support: [{ price: .45, touches: 3, lastIdx: 200, lastDate: '2026-10-19', dist: -3.23, kind: 'sup' }], resistance: [] },
    patterns: [{ id: 'double_bottom', name: '双底', en: 'Double Bottom', dir: 'bull', cat: 'bottom', tag: '颈线确认', conf: 78, date: '2026-10-29', at: 159, anchorAt: 155, confirmedAt: null, status: 'forming', fresh: true, note: '颈线 0.500，尚未突破。', buy: '观察突破0.500', sell: '结构失效重新评估', stop: '前低0.450', target: '测量目标0.550', triggerPrice: .5, stopPrice: .45, targetPrice: .55, vol_note: '量比1.2', volumeConfirmed: true, scaled: false, adviceSource: 'structure' }],
    verdict: { stance: '震荡偏空', stanceEn: 'flat-bear', score: -3.2, patternScore: 0, maScore: -3, trendScore: -.2, agree: false, advice: '长期下降，中期下降，短期上升，分项尚未同向。', bullCount: 1, bearCount: 0, neutralCount: 0, maAlign: '完全空头排列', ma: {}, volRatio: 1.25, nearestRes: null, nearestSup: null, rr: null },
    ...changes,
  }
}
const teaching: TeachingPattern = { id: 'double_bottom', name: '双底', en: 'Double Bottom', cat: 'bottom', dir: 'bull', tag: '等待突破颈线', candles: [[10, 11, 9, 10.5, 1]], lines: [], steps: ['<b>示例</b>低点不创新低'], buy: '示例买点108', sell: '示例卖点', stop: '示例止损', target: '示例目标', vol_note: '量能示例' }
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.analyze.mockReset().mockResolvedValue(result()); mocks.catalog.mockReset().mockResolvedValue({ version: 'v1', items: [teaching] })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.restoreAllMocks(); vi.useRealTimers() })
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }
async function render(props: Partial<StockTechnicalPanelProps> = {}) {
  await act(async () => root.render(<QueryClientProvider client={client}><StockTechnicalPanel
    symbol="512000.SH" rows={[{ date: '2026-10-29', open: .474, high: .474, low: .464, close: .465, volume: 100, is_closed: true }]}
    period="1d" selectedDate="2026-10-29" assetType="etf" {...props}
  /></QueryClientProvider>))
  await settle()
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(button => (button.getAttribute('aria-label') ?? button.textContent)?.includes(text))!
  expect(button).toBeDefined()
  await act(async () => button.click()); await settle()
}
it('使用新接口展示综合分、三级趋势、支撑阻力和形态，不显示原技术总分', async () => {
  await render()
  expect(mocks.analyze).toHaveBeenCalledWith('512000.SH', '1d', '2026-10-29', expect.arrayContaining([expect.objectContaining({ is_closed: true })]), undefined)
  for (const text of ['震荡偏空', '综合分 -3.2', '形态分', '均线分', '趋势分', '长期 · 120根', '支撑与阻力', '0.450', '双底', '形成中', '匹配度 78/100', '指标与数据明细']) expect(host.textContent).toContain(text)
  expect(host.textContent).not.toContain('信号可信度')
  expect(host.textContent).not.toContain('示例买点108')
  expect(mocks.catalog).not.toHaveBeenCalled()
})
it('教学库按需加载，教学示意与真实行情价位分开', async () => {
  await render(); await click('查看教学图解')
  expect(mocks.catalog).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('教学示例，非当前标的行情')
  expect(document.querySelector('svg[aria-label="双底教学示意图"]')).not.toBeNull()
  expect(document.querySelector('[role="dialog"] b')).toBeNull()
  await click('关闭教学'); await click('84形态库')
  expect(host.textContent).toContain('共 1 个形态')
  expect(mocks.catalog).toHaveBeenCalledTimes(1)
})
it('切换股票、周期和历史日期隔离查询，并携带未收盘状态', async () => {
  await render()
  mocks.analyze.mockResolvedValue(result({ symbol: '600519.SH', period: '30m', lastDate: '2026-10-28 10:00:00' }))
  await render({ symbol: '600519.SH', assetType: 'stock', period: '30m', selectedDate: '2026-10-28 10:30:00', rows: [{ date: '2026-10-28 10:30:00', open: 10, high: 11, low: 9, close: 10, is_closed: false }] })
  expect(mocks.analyze).toHaveBeenLastCalledWith('600519.SH', '30m', '2026-10-28 10:30:00', [expect.objectContaining({ is_closed: false })], undefined)
  expect(host.textContent).toContain('2026-10-28 10:00:00')
  expect(host.textContent).not.toContain('截至 2026-10-29')
})
it('无形态时不误导为无趋势，未收盘和不足样本有明确提示', async () => {
  mocks.analyze.mockResolvedValue(result({ patterns: [], forming: true }))
  await render()
  expect(host.textContent).toContain('无形态不等于无趋势')
  expect(host.textContent).toContain('未收盘K线已排除')
  mocks.analyze.mockResolvedValue(result({ status: 'insufficient', issues: ['至少需要30根已收盘K线'], verdict: { ...result().verdict, stance: '数据不足', stanceEn: 'unknown', score: null } }))
  await render({ selectedDate: '2026-10-28' })
  expect(host.textContent).toContain('至少需要30根已收盘K线')
  expect(host.textContent).toContain('综合分 —')
})
it('加载、失败和空数据不保留其他标的的结论，失败可重试', async () => {
  await render()
  mocks.analyze.mockImplementationOnce(() => new Promise(() => {}))
  await render({ symbol: 'NEW.SH' })
  expect(host.textContent).toContain('正在计算趋势')
  expect(host.textContent).not.toContain('震荡偏空')
  mocks.analyze.mockRejectedValueOnce(new Error('offline'))
  await render({ symbol: 'FAIL.SH' })
  expect(host.textContent).toContain('形态分析失败')
  mocks.analyze.mockResolvedValue(result()); await click('重试')
  expect(host.textContent).toContain('震荡偏空')
  await render({ rows: [] })
  expect(host.textContent).toContain('暂无K线数据')
  expect(host.textContent).not.toContain('震荡偏空')
})
it('展开指标显示与K线对齐的真实数值，完整JSON导出可用', async () => {
  await render()
  expect(host.textContent).toContain('MA20')
  expect(host.textContent).toContain('0.488')
  expect(host.textContent).toContain('RSI14')
  expect(host.textContent).toContain('计算样本 250 根')
  expect(host.querySelector('button[aria-label="导出完整分析JSON"]')?.hasAttribute('disabled')).toBe(false)
})
it('导出JSON包含七类原始结果，并保留Blob直到浏览器开始读取', async () => {
  await render()
  const create = vi.fn().mockReturnValue('blob:analysis')
  const revoke = vi.fn()
  Object.defineProperties(URL, { createObjectURL: { value: create, configurable: true }, revokeObjectURL: { value: revoke, configurable: true } })
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.isConnected).toBe(true)
    expect(this.download).toBe('512000.SH-1d-2026-10-29.json')
  })
  vi.useFakeTimers()
  await act(async () => (host.querySelector('button[aria-label="导出完整分析JSON"]') as HTMLButtonElement).click())
  expect(download).toHaveBeenCalledTimes(1)
  const blob = create.mock.calls[0][0] as Blob
  expect(blob.type).toBe('application/json')
  expect(revoke).not.toHaveBeenCalled()
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(revoke).toHaveBeenCalledWith('blob:analysis')
  vi.useRealTimers()
  const text = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsText(blob) })
  const exported = JSON.parse(text)
  for (const field of ['candles', 'indicators', 'trend', 'swings', 'levels', 'patterns', 'verdict']) expect(exported[field]).toEqual(result()[field as keyof TrendPatternAnalysis])
})

it('点击形态标题选择和取消，教学入口独立', async () => {
  const select = vi.fn()
  await render({ onPatternSelect: select })
  await click('双底')
  expect(select).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'double_bottom' }))
  await render({ selectedPattern: 'double_bottom', onPatternSelect: select })
  expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe('双底')
  await click('双底')
  expect(select).toHaveBeenLastCalledWith(null)
  select.mockClear()
  await click('查看教学图解')
  expect(select).not.toHaveBeenCalled()
})
