// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, type StrategyDetail } from '@/lib/api'
import { storage } from '@/lib/storage'
import { startBacktest } from '@/lib/backtestTask'
import { StrategyBacktest } from './StrategyBacktest'

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: {
    ...actual.api,
    screenerStrategies: vi.fn(), strategyGet: vi.fn(), instrumentSearch: vi.fn(),
    factorColumns: async () => ({ columns: [] }),
    factorLibrary: async () => ({ factors: [] }),
    customSignalsList: async () => ({ signals: [] }),
    watchlistList: vi.fn(),
    watchlistGroups: async () => ({ groups: [
      { id: 'mixed', name: '混合分组', color: 'sky', created_at: '' },
      { id: 'stock-only', name: '股票分组', color: 'sky', created_at: '' },
    ] }),
  } }
})
vi.mock('@/lib/backtestTask', () => ({
  startBacktest: vi.fn(), stopBacktest: vi.fn(), tryReconnect: vi.fn(), useBacktestTask: () => null,
}))
vi.mock('@/lib/useSharedQueries', () => ({
  useCapabilities: () => ({ data: { capabilities: {} } }),
  useDataStatus: () => ({ isSuccess: true, data: {
    enriched: { earliest_date: '2026-01-01' }, etf_enriched: { earliest_date: '2026-01-01' },
  } }),
}))
vi.mock('./charts/StrategyNavChart', () => ({ StrategyNavChart: () => null }))
vi.mock('./charts/ReturnDistributionChart', () => ({ ReturnDistributionChart: () => null }))
vi.mock('./components/TradeKlineModal', () => ({ TradeKlineModal: () => null }))
vi.mock('./components/PicksSymbolKlineModal', () => ({ PicksSymbolKlineModal: () => null }))

const strategy: StrategyDetail = {
  id: 'angel', name: '天使魔鬼', description: '', tags: [], source: 'custom',
  execution_backend: 'matrix_native', asset_types: ['stock', 'etf'], timeframes: ['1d'], version: '1',
  basic_filter: {}, params: [], params_defaults: {}, scoring: {}, scoring_directions: {},
  entry_signals: [], exit_signals: [], minute_exit_trigger_supported_signals: [],
  stop_loss: null, take_profit: null, trailing_stop: null,
  trailing_take_profit_activate: null, trailing_take_profit_drawdown: null, max_hold_days: null,
  order_by: '', descending: true, limit: 10,
}
let host: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  vi.clearAllMocks()
  storage.strategyBacktestLast.set({
    selectedStrategy: strategy.id, assetType: 'stock', symbols: '600519.SH',
    start: '2026-07-22', end: '2026-10-22', matching: 'open_t+1', entryFill: 'open_t+1', exitFill: 'open_t+1',
    fees: '2', slippage: '5', maxPositions: '10', maxExposure: '100', initialCapital: '1000000',
    positionSizing: 'equal', mode: 'position', holdingDays: '5', result: null,
  })
  vi.mocked(api.screenerStrategies).mockResolvedValue({ presets: [strategy], load_errors: [] })
  vi.mocked(api.strategyGet).mockImplementation(async id => id === 'etf-only'
    ? { ...strategy, id, name: 'ETF策略', asset_types: ['etf'] }
    : strategy)
  vi.mocked(api.instrumentSearch).mockResolvedValue({ results: [
    { symbol: '510300.SH', code: '510300', name: '沪深300ETF', asset_type: 'etf' },
  ] })
  vi.mocked(api.watchlistList).mockResolvedValue({ symbols: [] })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  host.remove()
  localStorage.clear()
})
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const button = (text: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text)!
async function click(element: HTMLButtonElement) {
  expect(element).toBeDefined()
  await act(async () => element.click())
  await settle()
}
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><StrategyBacktest /></QueryClientProvider>))
  await settle()
}
const drawer = () => host.querySelector('aside')
const assetScope = () => host.querySelector('[aria-label="回测资产范围"]')!
const settingsButton = () => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('策略设置'))!

it('places asset scope before strategy selection and removes it from advanced settings', async () => {
  storage.strategyBacktestLast.set(null)
  await render()
  expect(assetScope()).not.toBeNull()
  const selectionLabel = Array.from(host.querySelectorAll('label')).find(e => e.textContent === '选择策略')!
  expect(assetScope().compareDocumentPosition(selectionLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  await click(button('ETF'))
  expect(api.screenerStrategies).toHaveBeenLastCalledWith('etf', 'all')
  await click(button('天使魔鬼自定义'))
  await click(settingsButton())
  expect(drawer()).not.toBeNull()
  expect(drawer()?.textContent).not.toContain('资产类型')
  expect(button('回测范围')).toBeUndefined()
})

it('keeps a compatible strategy across both asset switches and submits the selected scope', async () => {
  await render()
  // Clicking the current type must not erase a configured pool.
  await click(button('股票'))
  expect(assetScope().textContent).toContain('600519.SH')
  await click(button('ETF'))
  expect(settingsButton().textContent).toContain('天使魔鬼')
  expect(assetScope().textContent).not.toContain('600519.SH')
  expect(button('ETF').getAttribute('aria-pressed')).toBe('true')
  await click(button('股票'))
  await click(button('ETF'))
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[placeholder="搜索ETF名称/代码添加标的"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '沪深300')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
  expect(api.instrumentSearch).toHaveBeenLastCalledWith('沪深300', 20, 'etf')
  await click(Array.from(assetScope().querySelectorAll('button')).find(b => b.textContent?.includes('510300.SH'))!)
  await click(button('运行回测'))
  expect(startBacktest).toHaveBeenCalledWith(expect.objectContaining({ strategy_id: 'angel', asset_type: 'etf', symbols: ['510300.SH'] }))
})

it.each([false, true])('keeps asset controls available when the strategy is incompatible (empty list: %s)', async empty => {
  let resolve!: (value: Awaited<ReturnType<typeof api.screenerStrategies>>) => void
  vi.mocked(api.screenerStrategies).mockImplementation(asset => asset === 'etf'
    ? new Promise(r => { resolve = r })
    : Promise.resolve({ presets: [strategy], load_errors: [] }))
  await render()
  await click(button('ETF'))
  expect(assetScope()).not.toBeNull()
  expect(button('运行回测').disabled).toBe(true)
  await act(async () => resolve({ presets: empty ? [] : [{ ...strategy, id: 'etf-only', name: 'ETF策略' }], load_errors: [] }))
  await settle()
  expect(assetScope()).not.toBeNull()
  expect(settingsButton().textContent).toContain('未选择策略')
  expect(button('天使魔鬼自定义')).toBeUndefined()
  if (!empty) {
    expect(button('ETF策略自定义')).toBeDefined()
    await click(button('ETF策略自定义'))
    expect(button('运行回测').disabled).toBe(false)
    await click(button('股票'))
    await click(button('ETF'))
  }
  expect(button('运行回测').disabled).toBe(true)
  // The scope must remain reachable even when no strategy can be selected.
  await click(button('股票'))
  await click(button('天使魔鬼自定义'))
  expect(button('运行回测').disabled).toBe(false)
})

it('imports only the active asset type for all, grouped and ungrouped watchlists', async () => {
  vi.mocked(api.watchlistList).mockResolvedValue({ symbols: [
    { symbol: '600519.SH', name: '贵州茅台', asset_type: 'stock', added_at: '', group_ids: ['mixed', 'stock-only'] },
    { symbol: '000001.SZ', name: '平安银行', asset_type: 'stock', added_at: '', group_ids: [] },
    { symbol: '510300.SH', name: '沪深300ETF', asset_type: 'etf', added_at: '', group_ids: ['mixed'] },
    { symbol: '159605.SZ', name: '中概互联ETF', asset_type: 'etf', added_at: '', group_ids: [] },
    { symbol: '000001.SH', name: '上证指数', asset_type: 'index', added_at: '', group_ids: ['mixed'] },
    { symbol: 'unknown', added_at: '', group_ids: ['mixed'] },
  ] })
  await render()
  const importButton = () => host.querySelector<HTMLButtonElement>('[aria-label="从自选分组导入回测范围"]')!
  const menuItem = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b => b.textContent?.includes(label))!
  expect(importButton().textContent).toContain('导入自选股(2)')
  await click(importButton())
  expect(menuItem('全部自选').textContent).toContain('2')
  expect(menuItem('混合分组').textContent).toContain('1')
  await click(menuItem('全部自选'))
  expect(assetScope().textContent).toContain('600519.SH')
  expect(assetScope().textContent).toContain('000001.SZ')
  expect(assetScope().textContent).not.toContain('510300.SH')
  await click(button('ETF'))
  expect(importButton().textContent).toContain('导入自选ETF(2)')
  await click(importButton())
  expect(menuItem('股票分组').disabled).toBe(true)
  expect(menuItem('未分组').textContent).toContain('1')
  await click(menuItem('混合分组'))
  expect(assetScope().textContent).toContain('510300.SH')
  expect(assetScope().textContent).not.toContain('600519.SH')
  expect(assetScope().textContent).not.toContain('000001.SH')
  expect(assetScope().textContent).not.toContain('unknown')
  await click(importButton())
  await click(menuItem('未分组'))
  await click(button('运行回测'))
  expect(startBacktest).toHaveBeenCalledWith(expect.objectContaining({ asset_type: 'etf', symbols: ['510300.SH', '159605.SZ'] }))
})

it('disables importing when only other assets are available', async () => {
  vi.mocked(api.watchlistList).mockResolvedValue({ symbols: [
    { symbol: '510300.SH', asset_type: 'etf', added_at: '' },
  ] })
  await render()
  expect(host.querySelector<HTMLButtonElement>('[aria-label="从自选分组导入回测范围"]')!.disabled).toBe(true)
  await click(button('ETF'))
  expect(host.querySelector<HTMLButtonElement>('[aria-label="从自选分组导入回测范围"]')!.disabled).toBe(false)
})
