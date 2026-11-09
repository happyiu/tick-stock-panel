// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AllocationPortfolio, AllocationTrackingHistory } from '@/lib/api'
import AssetAllocation from './AssetAllocation'

const calls = vi.hoisted(() => ({
  calculations: 0,
  devilPreview: false,
  daily: vi.fn(async () => ({ rows: [] })),
  period: vi.fn(async () => ({ rows: [] })),
  replay: vi.fn<(body: AllocationPortfolio) => Promise<AllocationTrackingHistory>>(),
  payloads: [] as { mode: string; body: Record<string, unknown> }[],
  saved: [] as { id: string; body: Record<string, unknown> }[],
  messages: [] as { message: string; kind: string }[],
}))
vi.mock('echarts', () => ({ init: () => ({ setOption() {}, resize() {}, dispose() {} }) }))
vi.mock('@/components/Toast', () => ({ toast: (message: string, kind = 'error') => calls.messages.push({ message, kind }) }))
vi.mock('@/lib/api', () => ({ api: {
  klineDaily: calls.daily,
  indexDaily: async () => ({ rows: [] }),
  klinePeriod: calls.period,
  instrumentNames: async () => ({ names: { '510300.SH': '沪深300 ETF' } }),
  watchlistList: async () => ({ symbols: [] }),
  watchlistGroups: async () => ({ groups: [] }),
  allocationTracking: async () => ({}),
  allocationTrackingHistory: calls.replay,
  allocationSchemes: async () => ({
    default_scheme_id: 'devil_trader',
    schemes: {
      devil_trader: { name: '魔鬼操盘手', ready: false, position_ready: calls.devilPreview, current_weights_ready: calls.devilPreview },
      first: { name: '测试方案甲', ready: true },
      second: { name: '测试方案乙', ready: true },
      third: { name: '测试方案丙', ready: true },
    },
  }),
  allocationPortfolios: async () => ({ one: calls.devilPreview
    ? { name: '已保存', symbols: ['510300.SH', '512000.SH', '159992.SZ'], lookback: 126, max_weight: .3, initial_capital: 100000, scheme_id: 'devil_trader' }
    : { name: '已保存', symbols: ['510300.SH'], lookback: 126, max_weight: 1, initial_capital: 100000, scheme_id: 'first' } }),
  allocationSave: async (id: string, body: Record<string, unknown>) => {
    calls.saved.push({ id, body })
    return { [id]: body }
  },
  allocationCalculate: async (mode: string, body: Record<string, unknown>) => {
    calls.calculations++
    calls.payloads.push({ mode, body })
    if (calls.devilPreview && body.scheme_id === 'devil_trader') {
      return {
        parameters: body, names: { '510300.SH': '沪深300 ETF' }, as_of: '2026-11-06',
        total_position: .7, market_score: 37, market_regime: '中性',
        etf_allocations: [
          { symbol: '510300.SH', score: 85, weight: .3, amount: 30000 },
          { symbol: '512000.SH', score: 15, weight: .105, amount: 10500 },
          { symbol: '159992.SZ', score: null, weight: 0, amount: 0 },
        ],
        cash_weight: .595, cash_amount: 59500,
      }
    }
    const history = { return: .1, drawdown: -.05, points: [{ date: '2026-01-01', value: 1 }, { date: '2026-11-06', value: 1.1 }] }
    const initialCapital = Number(body.initial_capital)
    return { weights: [1], risk_contribution: [1], target_amounts: Number.isFinite(initialCapital) ? { scheme: [initialCapital], equal: [initialCapital] } : undefined,
      parameters: { ...body, symbols: ['510300.SH'] }, history: { scheme: history, equal: history },
      as_of: '2026-11-06', samples: 126, names: { '510300.SH': '沪深300 ETF' } }
  },
} }))

let host: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} } })
  calls.calculations = 0
  calls.devilPreview = false
  calls.daily.mockClear()
  calls.period.mockClear()
  calls.replay.mockReset()
  calls.payloads = []
  calls.saved = []
  calls.messages = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['allocation-portfolios'], { one: { name: '已保存', symbols: ['510300.SH'], lookback: 126, max_weight: 1, initial_capital: 100000, scheme_id: 'first' } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<QueryClientProvider client={client}><AssetAllocation /></QueryClientProvider>))
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })
const click = async (label: string) => {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label)!
  expect(button).toBeTruthy()
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
}
const selectSaved = async () => {
  const currentConfig = host.querySelector<HTMLButtonElement>('[aria-label^="配置 "]')!
  await act(async () => { currentConfig.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
  const savedConfig = host.querySelector<HTMLButtonElement>('#allocation-portfolio-menu button')!
  await act(async () => { savedConfig.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
}
const fill = async (label: string, value: string) => {
  const input = document.body.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  expect(input).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('shows the compact market trend above the target allocation', async () => {
  const market = host.querySelector('[aria-label="市场环境"]')!
  const target = host.querySelector('[aria-label="仓位结果"]')!
  expect(market.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(market.textContent).not.toContain('上证指数')
  expect(market.textContent).not.toContain('综合趋势分')
  expect(market.textContent).not.toContain('各周期最近信号')
  expect(market.querySelector('h3')).toBeNull()
  expect(market.textContent).toContain('周线')
  expect(market.textContent).toContain('日线')
  expect(market.textContent).toContain('30F')
  expect(market.textContent).not.toContain('周线历史汇总')
  expect(calls.daily).toHaveBeenCalledWith('000001.SH', undefined, expect.any(Object), undefined, false, undefined, undefined)
  expect(calls.period.mock.calls.map(args => args.slice(0, 2))).toEqual([['000001.SH', '1w'], ['000001.SH', '30m']])
})

it('restores a saved portfolio and displays its ETF and parameters', async () => {
  await selectSaved()
  expect(host.textContent).toContain('510300.SH')
  expect(host.querySelector('[aria-label="回看交易日"]')).toBeNull()
})

it('guides new users to the renamed history backtest tab', async () => {
  await click('新建配置')
  await fill('新建配置名称', '测试配置')
  await fill('新建配置资金', '100000')
  await click('创建配置')
  expect(calls.saved).toHaveLength(1)
  expect(calls.messages).toEqual([{ message: '配置已创建并保存。', kind: 'success' }])
  expect(host.textContent).not.toContain('配置已创建并保存')
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('配置仓位')
  expect(host.textContent).toContain('等待目标仓位')
  expect(host.querySelector<HTMLInputElement>('[aria-label="开始日期"]')).toBeNull()
  await click('历史回测')
  expect(host.textContent).not.toContain('请先保存配置，再更新调仓建议')
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === '更新调仓建议')?.disabled).toBe(true)
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('历史回测')
  expect(host.querySelector('[aria-label="开始日期"]')).toBeNull()
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].some(b => b.textContent?.trim() === '运行历史回测')).toBe(false)
})

it('keeps selected ETFs across tabs and clears stale calculated results after edits', async () => {
  await selectSaved()
  await click('更新目标仓位')
  expect(calls.calculations).toBe(2)
  expect(host.textContent).toContain('目标仓位')
  expect(host.textContent).toContain('100.00%')
  await click('历史回测')
  await click('配置仓位')
  expect(host.textContent).toContain('100.00%')
  const remove = host.querySelector<HTMLButtonElement>('[aria-label="移除 510300.SH"]')!
  await act(async () => remove.click())
  expect(host.textContent).toContain('等待目标仓位')
  expect(host.textContent).not.toContain('100.00%')
})

it('creates and saves a portfolio with initial capital, then restores the amount', async () => {
  await click('新建配置')
  await act(async () => new Promise(resolve => setTimeout(resolve, 25)))
  expect(document.activeElement).not.toBe(document.body.querySelector('[aria-label="新建配置名称"]'))
  expect(document.body.querySelector<HTMLInputElement>('[aria-label="新建配置资金"]')?.value).toBe('100000')
  await fill('新建配置名称', '资金配置')
  await fill('新建配置资金', '100000.5')
  expect([...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === '创建配置')?.disabled).toBe(true)
  await fill('新建配置资金', '100001')
  await click('创建配置')
  expect(host.querySelector<HTMLInputElement>('[aria-label="资金"]')?.value).toBe('100001')
  expect(calls.saved).toHaveLength(1)
  expect(calls.saved[0].body).toMatchObject({ name: '资金配置', initial_capital: 100001, scheme_id: 'devil_trader' })
  const currentConfig = host.querySelector<HTMLButtonElement>('[aria-label^="配置 "]')!
  await act(async () => { currentConfig.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
  await act(async () => { host.querySelector<HTMLButtonElement>('#allocation-portfolio-menu button')!.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(host.querySelector<HTMLInputElement>('[aria-label="资金"]')?.value).toBe('100001')
})

it('shows target allocations and performance in currency after calculation', async () => {
  await selectSaved()
  await click('更新目标仓位')
  expect(calls.payloads.at(-1)?.body.initial_capital).toBe(100000)
  expect(host.textContent).toContain('¥100,000.00')
  expect(host.textContent).toContain('期末资产')
  expect(host.textContent).toContain('累计盈亏')
  expect(host.textContent).toContain('最大回撤')
})

it('clears calculated results when the configured capital changes', async () => {
  await selectSaved()
  await click('更新目标仓位')
  expect(host.textContent).toContain('期末资产')
  await fill('资金', '200000')
  expect(host.textContent).not.toContain('期末资产')
  await click('更新目标仓位')
  expect(calls.payloads.at(-1)?.body.initial_capital).toBe(200000)
  expect(host.textContent).toContain('¥200,000.00')
})

it('defaults a legacy portfolio to the pending scheme and saves it without calculating', async () => {
  client.setQueryData(['allocation-portfolios'], { one: { name: '旧配置', symbols: ['510300.SH'], lookback: 126, max_weight: 1 } })
  await selectSaved()
  expect(host.querySelector('select')?.value).toBe('devil_trader')
  expect(host.textContent).toContain('魔鬼操盘手的规则待补充')
  expect(host.textContent).toContain('510300.SH')
  await click('更新目标仓位')
  expect(calls.calculations).toBe(1)
  await click('保存配置')
  expect(calls.saved.at(-1)?.body).toMatchObject({ symbols: ['510300.SH'], scheme_id: 'devil_trader' })
})

it('automatically shows capped ETF allocations and cash, and refreshes on request', async () => {
  await act(async () => root.unmount())
  client.clear()
  calls.devilPreview = true
  calls.payloads = []
  root = createRoot(host)
  await act(async () => root.render(<QueryClientProvider client={client}><AssetAllocation /></QueryClientProvider>))
  await vi.waitFor(async () => {
    await act(async () => new Promise(resolve => setTimeout(resolve, 0)))
    const table = host.querySelector('[aria-label="ETF 目标配比"]')
    expect(table?.textContent).toContain('数据不足')
  })
  expect(calls.payloads).toHaveLength(1)
  expect(host.textContent).toContain('总仓位上限')
  expect(host.textContent).toContain('70.00%')
  expect(host.textContent).toContain('40.50%')
  expect(host.textContent).toContain('59.50%')
  expect(host.textContent).toContain('¥59,500.00')
  expect(host.textContent).not.toContain('使合计可达到 100%')
  await click('更新目标仓位')
  expect(calls.payloads).toHaveLength(2)
  await click('历史回测')
  const history: AllocationTrackingHistory = {
    start: '2026-11-04', end: '2026-11-06', sessions: 3, requested_sessions: 126,
    names: { '510300.SH': '沪深300 ETF' },
    history: {
      scheme: { return: .05, drawdown: -.04, points: [{ date: '2026-11-05', value: 1.05, drawdown: 0 }] },
      equal: { return: .02, drawdown: -.03, points: [{ date: '2026-11-05', value: 1.02, drawdown: 0 }] },
    },
    events: [{
      date: '2026-11-05', reason: 'initial', market_score: 37, total_position: .7,
      previous_position: null, max_deviation: null, previous_cash: 1, cash_weight: .7, equal_cash_weight: .75,
      etf_allocations: [{ symbol: '510300.SH', score: 85, previous_weight: 0, weight: .3, change: .3, equal_weight: .25 }],
    }],
    trades: [
      { date: '2026-11-05', model: 'scheme', symbol: '510300.SH', side: 'buy', reason: 'attack', price: 4.5, weight: .3, realized_pnl: null },
      { date: '2026-11-06', model: 'scheme', symbol: '510300.SH', side: 'sell', reason: 'retreat', price: 4.7, weight: 0, realized_pnl: .002 },
      { date: '2026-11-06', model: 'equal', symbol: '510300.SH', side: 'sell', reason: 'retreat', price: 4.7, weight: 0, realized_pnl: -.001 },
    ],
    skipped: [{ date: '2026-11-04', market_missing: true, symbols: ['510300.SH'] }],
  }
  await fill('触发偏离', '4')
  await fill('回看单边费率', '0.02')
  await fill('回看滑点', '0.05')
  expect(host.querySelector('[aria-label="回看开始日期"]')).toBeTruthy()
  expect(host.querySelector('[aria-label="回看结束日期"]')).toBeTruthy()
  calls.replay.mockResolvedValueOnce(history)
  await click('回看调仓历史')
  expect(calls.replay).toHaveBeenLastCalledWith(expect.objectContaining({
    start: expect.any(String), end: expect.any(String), threshold: .04, lookback: 126, fee: .0002, slippage: .0005,
  }))
  expect(host.textContent).toContain('初始目标 2026-11-05')
  expect(host.textContent).toContain('魔鬼操盘手首次买入 2026-11-05')
  expect(host.querySelector('[aria-label="模拟成交"]')?.textContent).toContain('进攻信号')
  expect(host.querySelector('[aria-label="模拟成交组合"] [role="tab"][aria-selected="true"]')?.textContent).toBe('方案')
  expect(host.querySelector('[aria-label="模拟成交"]')?.textContent).toContain('+¥200.00')
  await click('等权对照')
  expect(host.querySelector('[aria-label="模拟成交组合"] [role="tab"][aria-selected="true"]')?.textContent).toBe('等权对照')
  expect(host.querySelector('[aria-label="模拟成交"]')?.textContent).toContain('-¥100.00')
  expect(host.textContent).toContain('实际覆盖 2026-11-04 至 2026-11-06 · 3 个交易日')
  expect(host.textContent).toContain('等权对照 · 累计收益')
  expect(host.textContent).toContain('最大回撤 -4.00%')
  expect(host.textContent).toContain('¥105,000.00')
  await click('回撤曲线')
  expect(host.querySelector('[aria-label="两组回撤曲线"]')).toBeTruthy()
  await click('仓位明细')
  expect(host.querySelector('table[aria-label="2026-11-05 仓位明细"]')?.textContent).toContain('75.00%')
  expect(host.querySelector('details ul')?.textContent).toContain('市场环境评分')
  expect(host.textContent).not.toContain('少于请求的 126 天')

  let resolveReplay!: (history: AllocationTrackingHistory) => void
  calls.replay.mockReturnValueOnce(new Promise(resolve => { resolveReplay = resolve }))
  await click('回看调仓历史')
  expect(host.querySelector('[role="status"]')?.textContent).toContain('正在计算')
  await fill('回看单边费率', '0.03')
  await act(async () => resolveReplay(history))
  expect(host.textContent).not.toContain('初始目标 2026-11-05')

  calls.replay.mockResolvedValueOnce({ ...history, history: undefined, performance_error: '缺少收盘价' })
  await click('回看调仓历史')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('缺少收盘价')
  expect(host.textContent).toContain('初始目标 2026-11-05')
  await selectSaved()
  expect(host.textContent).not.toContain('初始目标 2026-11-05')

  calls.replay.mockResolvedValueOnce({ ...history, events: [], history: undefined })
  await click('回看调仓历史')
  expect(host.textContent).toContain('无法确定目标仓位')
  calls.replay.mockRejectedValueOnce(new Error('交易日历不足'))
  await click('回看调仓历史')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('交易日历不足')
})

it('uses the selected scheme for estimates and saved tracking', async () => {
  await selectSaved()
  await click('更新目标仓位')
  expect(host.textContent).toContain('测试方案甲 金额')
  const chooseScheme = async (value: string) => {
    const select = host.querySelector<HTMLSelectElement>('select')!
    await act(async () => {
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  await chooseScheme('second')
  expect(host.textContent).not.toContain('测试方案甲 金额')
  await click('更新目标仓位')
  expect(calls.payloads.at(-1)?.body.scheme_id).toBe('second')
  expect(host.textContent).toContain('测试方案乙 金额')
  expect(host.textContent).toContain('测试方案乙 · 累计收益')
  await click('历史回测')
  expect(host.textContent).toContain('配置方案：测试方案乙')
  expect(host.textContent).toContain('请先保存配置，再更新调仓建议')
  await click('保存配置')
  expect(calls.saved.at(-1)?.body.scheme_id).toBe('second')
  expect(host.textContent).not.toContain('请先保存配置，再更新调仓建议')
  await selectSaved()
  await click('配置仓位')
  expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('second')
})
