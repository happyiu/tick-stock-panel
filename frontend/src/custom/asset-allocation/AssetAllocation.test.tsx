// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AssetAllocation from './AssetAllocation'

const calls = vi.hoisted(() => ({
  calculations: 0,
  devilPreview: false,
  daily: vi.fn(async () => ({ rows: [] })),
  period: vi.fn(async () => ({ rows: [] })),
  payloads: [] as { mode: string; body: Record<string, unknown> }[],
  saved: [] as { id: string; body: Record<string, unknown> }[],
  messages: [] as { message: string; kind: string }[],
}))
vi.mock('echarts', () => ({ init: () => ({ setOption() {}, resize() {}, dispose() {} }) }))
vi.mock('@/components/Toast', () => ({ toast: (message: string, kind = 'error') => calls.messages.push({ message, kind }) }))
vi.mock('@/lib/api', () => ({ api: {
  klineDaily: calls.daily,
  klinePeriod: calls.period,
  instrumentNames: async () => ({ names: { '510300.SH': '沪深300 ETF' } }),
  watchlistList: async () => ({ symbols: [] }),
  watchlistGroups: async () => ({ groups: [] }),
  allocationTracking: async () => ({}),
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
    const account = [{ date: '2026-06-01', cash: .2, value: 1.1, weights: [.8], target: [1] }]
    const backtestData = mode === 'backtest' ? {
      trades: [{ model: 'scheme', date: '2026-06-01', symbol: '510300.SH', side: 'buy', reason: 'attack', price: 1, amount: .2, cost: .001, weights: [1] }],
      schedule: [{ date: '2026-06-01', signals: ['attack'], weights: [1] }],
      accounts: { scheme: account, equal: account },
    } : {}
    return { weights: [1], risk_contribution: [1], target_amounts: Number.isFinite(initialCapital) ? { scheme: [initialCapital], equal: [initialCapital] } : undefined,
      parameters: { ...body, symbols: ['510300.SH'] }, history: { scheme: history, equal: history }, ...backtestData,
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
  expect(host.querySelector<HTMLInputElement>('[aria-label="回看交易日"]')!.value).toBe('126')
})

it('guides new users and keeps tracking and backtest separate from configuration', async () => {
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
  await click('调仓跟踪')
  expect(host.textContent).not.toContain('请先保存配置，再更新调仓建议')
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === '更新调仓建议')?.disabled).toBe(true)
  await click('历史回测')
  expect(host.textContent).toContain('填写 0.02 代表')
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === '运行历史回测')?.disabled).toBe(true)
})

it('keeps selected ETFs across tabs and clears stale calculated results after edits', async () => {
  await selectSaved()
  await click('更新目标仓位')
  expect(calls.calculations).toBe(2)
  expect(host.textContent).toContain('目标仓位')
  expect(host.textContent).toContain('100.00%')
  await click('调仓跟踪')
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
  await click('调仓跟踪')
  expect(host.textContent).toContain('当前方案暂未开放调仓跟踪')
})

it('uses the selected scheme for estimates, saved tracking and unsaved backtests', async () => {
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
  await click('调仓跟踪')
  expect(host.textContent).toContain('配置方案：测试方案乙')
  expect(host.textContent).toContain('请先保存配置，再更新调仓建议')
  await click('保存配置')
  expect(calls.saved.at(-1)?.body.scheme_id).toBe('second')
  expect(host.textContent).not.toContain('请先保存配置，再更新调仓建议')
  await selectSaved()
  await click('配置仓位')
  expect(host.querySelector<HTMLSelectElement>('select')?.value).toBe('second')
  await chooseScheme('third')
  await click('历史回测')
  await fill('开始日期', '2026-06-01')
  await fill('结束日期', '2026-11-07')
  await click('运行历史回测')
  expect(calls.payloads.at(-1)).toMatchObject({ mode: 'backtest', body: { scheme_id: 'third' } })
  expect(host.textContent).toContain('测试方案丙 · 累计收益')
  expect(host.textContent).toContain('测试方案丙 实际持仓')
  await click('配置仓位')
  await chooseScheme('first')
  await click('历史回测')
  expect(host.textContent).not.toContain('测试方案丙 实际持仓')
})

it('runs the fixed Angel Devil close-price rule with explicit fee units', async () => {
  await selectSaved()
  await click('历史回测')
  expect(host.textContent).toContain('首日没有进攻信号就保持现金')
  expect(host.querySelector('[aria-label="调仓规则"]')).toBeNull()
  await fill('开始日期', '2026-06-01')
  await fill('结束日期', '2026-11-07')
  await fill('单边费率', '0.02')
  await click('运行历史回测')
  expect(calls.payloads.at(-1)).toMatchObject({
    mode: 'backtest', body: { initial_capital: 100000, rebalance: 'angel_devil', start: '2026-06-01', end: '2026-11-07', fee: .0002 },
  })
  expect(host.textContent).toContain('天使魔鬼信号与动态配比回测')
  const tradesSummary = [...document.body.querySelectorAll<HTMLElement>('details summary')].find(summary => summary.textContent?.startsWith('成交明细'))!
  await act(async () => tradesSummary.click())
  expect(host.textContent).toContain('¥20,000.00 / 20.00%')
  expect(host.textContent).toContain('¥100.00 / 0.10%')
  const accountSummary = [...document.body.querySelectorAll<HTMLElement>('details summary')].find(summary => summary.textContent?.startsWith('每日配比与持仓'))!
  await act(async () => accountSummary.click())
  expect(host.textContent).toContain('¥90,000.00')
  expect(host.textContent).toContain('¥20,000.00')
  expect(host.textContent).toContain('¥110,000.00')
})
