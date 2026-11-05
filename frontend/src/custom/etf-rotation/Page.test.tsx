// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Page, { Environment } from './Page'

const mocks = vi.hoisted(() => ({ check: vi.fn(), start: vi.fn(), preview: vi.fn() }))
vi.mock('./Charts', () => ({ RotationCharts: () => <div>净值曲线</div> }))
vi.mock('@/lib/api', () => ({ api: {
  rotationStrategies: async () => ({ templates: [
    { name: '复合动量', strategy: 'composite_momentum', symbols: ['510050.SH', '510500.SH'], haven_symbol: '518880.SH', reference_symbol: '510300.SH', parameters: { adjustment_days: 3, trend_weight: .25 }, fees: { commission: .0002, slippage: .0001, minimum: 0 } },
    { name: '黄金避险', strategy: 'gold_safe_haven', symbols: ['510300.SH', '510500.SH'], haven_symbol: '518880.SH', reference_symbol: '510300.SH', parameters: { adjustment_days: 1, bull_filter: true }, fees: { commission: .0002, slippage: .0001, minimum: 0 } },
    { name: '复合动量·环境增强', strategy: 'composite_momentum_enhanced', symbols: ['510050.SH', '510500.SH'], haven_symbol: '518880.SH', reference_symbol: '510300.SH', parameters: { adjustment_days: 3, trend_weight: .25, market_ma_period: 60, market_band: .02, bull_exposure: 1, neutral_exposure: .5, bear_exposure: 0 }, fees: { commission: .0002, slippage: .0001, minimum: 0 } },
  ], parameters: { properties: {} }, closed_date: '2026-11-03' }),
  rotationConfigs: async () => ({ items: [] }), rotationJobs: async () => ({ items: [] }),
  instrumentNames: async () => ({ names: {} }), instrumentSearch: async () => ({ results: [] }),
  rotationCheck: mocks.check, rotationStart: mocks.start, rotationPreview: mocks.preview,
} }))
let host: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.check.mockReset().mockResolvedValue({ ready: true, coverage: [], warmup_bars: 64 })
  mocks.preview.mockReset().mockRejectedValue(new Error('参考ETF日线缺失'))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })
async function settle() { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
async function render() { await act(async () => root.render(<QueryClientProvider client={client}><Page /></QueryClientProvider>)); await settle() }
function find(text: string) { return [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))! }
async function click(text: string) { await act(async () => find(text).click()); await settle() }
it('requires a fresh coverage check after editing the ETF pool', async () => {
  await render()
  expect(find('开始回测').disabled).toBe(true)
  await click('检查数据覆盖')
  expect(find('开始回测').disabled).toBe(false)
  await click('510050.SH')
  expect(find('开始回测').disabled).toBe(true)
  expect(mocks.check.mock.lastCall?.[0].config.symbols).toHaveLength(2)
})
it('resets strategy parameters and reveals separate haven/reference configuration', async () => {
  await render()
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="策略模板"]')!
    select.value = 'gold_safe_haven'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(host.textContent).toContain('参考ETF：')
  expect(host.textContent).toContain('避险ETF：')
  expect(host.querySelector('[aria-label="添加位置"]')).not.toBeNull()
})
it('shows decision failures without fabricating an empty successful preview', async () => {
  await render(); await click('决策预览'); await click('刷新决策预览')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('参考ETF日线缺失')
  expect(mocks.preview.mock.lastCall?.[1]).toBeUndefined()
})
it('exposes environment sizing only in the enhanced template', async () => {
  await render()
  expect(host.textContent).not.toContain('牛市目标仓位')
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="策略模板"]')!
    select.value = 'composite_momentum_enhanced'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(host.textContent).toContain('牛市目标仓位')
  expect(host.textContent).toContain('震荡目标仓位')
  expect(host.textContent).toContain('熊市目标仓位')
  expect(host.textContent).toContain('收益可能变好也可能变差')
})
it('shows exact environment evidence without treating the market score as the trading rule', async () => {
  await act(async () => root.render(<Environment environment={{ symbol: '000300.SH', close: 3900, ma: 4100, ma_period: 60, deviation: 3900 / 4100 - 1, band: .02, regime: 'bear', score_multiplier: .8, controls_exposure: true, target_exposure: 0, market_context: { date: '2026-11-02', state: 'lean_weak', score: 38 } }} />))
  expect(host.textContent).toContain('轮动市场环境：熊市')
  expect(host.textContent).toContain('MA60 4100.00')
  expect(host.textContent).toContain('目标仓位 0.00%')
  expect(host.textContent).toContain('38分')
  expect(host.textContent).toContain('仅作参考')
})
it('blocks a run when the reference index has gaps inside an otherwise warm window', async () => {
  mocks.check.mockResolvedValue({ ready: false, proposed_start: null, coverage: [], warmup_bars: 64, incomplete_days: 20, missing_index_dates: ['2026-09-22'], reason: '区间内有20个交易日数据或预热不完整' })
  await render(); await click('检查数据覆盖')
  expect(find('开始回测').disabled).toBe(true)
  expect(host.textContent).toContain('沪深300日线缺失 1 日')
  expect(host.textContent).toContain('2026-09-22')
})
