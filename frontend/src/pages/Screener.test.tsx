// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Screener } from './Screener'
import { api, type MonitorRule } from '@/lib/api'
import { storage } from '@/lib/storage'

const fixture = vi.hoisted(() => ({ latest: '2026-10-16', rules: [] as MonitorRule[] }))
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: {
  screenerStrategies: vi.fn(async () => ({ presets: [{ id: 'test', name: '测试策略', description: '', source: 'custom', asset_types: ['stock', 'etf'], timeframes: ['1d', '30m', '1m'] }], load_errors: [] })),
  screenerCachedSummary: vi.fn(async () => ({ results: {} })),
  screenerRunPreset: vi.fn(async (id, _params, date) => ({ strategy: id, as_of: date, rows: [], total: 0, elapsed_ms: 0 })),
  screenerRunAll: vi.fn(async date => ({ as_of: date, results: { test: { as_of: date, rows: [], total: 0 } } })),
  screenerResultColumns: vi.fn(async () => ({ columns: [] })),
  watchlistList: vi.fn(async () => ({ symbols: [] })),
  monitorRulesList: vi.fn(async () => ({ rules: fixture.rules })),
  monitorRuleSave: vi.fn(async (rule: MonitorRule) => {
    fixture.rules = [...fixture.rules, rule]
    return { ok: true, rule }
  }),
  monitorRuleDelete: vi.fn(async (id: string) => {
    fixture.rules = fixture.rules.filter(rule => rule.id !== id)
    return { ok: true }
  }),
  minuteRefreshStatus: vi.fn(async () => ({ running: false })),
} }))
vi.mock('@/lib/useSharedQueries', () => ({
  useDataStatus: () => ({ data: { enriched: { latest_date: fixture.latest, earliest_date: '2024-01-01' } } }),
  usePreferences: () => ({ data: { screener_auto_run: false } }),
  useCapabilities: () => ({ data: { capabilities: {} } }),
  useQuoteStatus: () => ({ data: {} }),
}))
vi.mock('@/lib/useSharedMutations', () => ({ useWatchlistBatchAdd: () => ({ mutate: vi.fn(), isPending: false }) }))
vi.mock('@/components/DatePicker', () => ({ DatePicker: ({ value, onChange }: { value: string; onChange: (date: string) => void }) => <input aria-label="选股日期" value={value} onChange={e => onChange(e.target.value)} /> }))
vi.mock('@/components/StockPreviewDialog', () => ({ StockPreviewDialog: () => null }))
vi.mock('@/components/screener/StrategySettingsDialog', () => ({ StrategySettingsDialog: ({ strategyId, onSaved }: { strategyId: string | null; onSaved: () => void }) => strategyId ? <button onClick={onSaved}>保存测试设置</button> : null }))
vi.mock('@/components/screener/StrategyPoolDialog', () => ({ StrategyPoolDialog: () => null }))
vi.mock('@/components/screener/StrategyBuilderDialog', () => ({ StrategyBuilderDialog: () => null }))
vi.mock('@/components/screener/CompositeStrategyDialog', () => ({ CompositeStrategyDialog: () => null }))
vi.mock('@/components/screener/StrategyStoreDialog', () => ({ StrategyStoreDialog: () => null }))

let host: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }
const click = async (name: string) => {
  const target = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === name || button.getAttribute('aria-label') === name || button.title === name)
  expect(target, name).toBeDefined()
  await act(async () => target!.click()); await settle()
}
const chooseDate = async (date: string) => {
  const input = host.querySelector<HTMLInputElement>('[aria-label="选股日期"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, date)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear(); vi.clearAllMocks(); fixture.latest = '2026-10-16'
  fixture.rules = []
  storage.strategyPool.set(['test'])
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })
const render = async (asset: 'stock' | 'etf') => {
  storage.screenerAssetType.set(asset)
  await act(async () => root.render(<QueryClientProvider client={client}><Screener /></QueryClientProvider>))
  await settle(); await settle()
}

it.each(['stock', 'etf'] as const)('%s 添加策略监控时携带当前资产类型', async asset => {
  await render(asset)
  await click('开启策略监控')
  expect(api.monitorRuleSave).toHaveBeenCalledWith(expect.objectContaining({
    type: 'strategy', strategy_id: 'test', asset_type: asset,
  }))
  expect(host.querySelector('button[title="取消策略监控"]')).not.toBeNull()
})

it('同一策略的股票和 ETF 监控状态及取消操作互不影响, 旧规则默认属于股票', async () => {
  fixture.rules = [{
    id: 'legacy-stock', name: '旧股票规则', enabled: true, type: 'strategy',
    strategy_id: 'test', scope: 'all', symbols: [], direction: 'entry',
    conditions: [], logic: 'or', cooldown_seconds: 3600, severity: 'info', message: '',
  }]
  await render('etf')
  await click('开启策略监控')
  expect(api.monitorRuleDelete).not.toHaveBeenCalled()
  const etfRule = vi.mocked(api.monitorRuleSave).mock.calls[0][0]
  expect(etfRule.asset_type).toBe('etf')
  await click('股票')
  await click('取消策略监控')
  expect(api.monitorRuleDelete).toHaveBeenLastCalledWith('legacy-stock')
  expect(host.querySelector('button[title="开启策略监控"]')).not.toBeNull()
  await click('ETF')
  await click('取消策略监控')
  expect(api.monitorRuleDelete).toHaveBeenLastCalledWith(etfRule.id)
  expect(host.querySelector('button[title="开启策略监控"]')).not.toBeNull()
})

it('ETF 30F 切换日期后自动重跑已选策略，并忽略旧日期的迟到结果', async () => {
  await render('etf'); await click('30F')
  expect(host.textContent).toContain('任意一根满足即命中')
  let finishOldRun!: (result: any) => void
  vi.mocked(api.screenerRunPreset).mockImplementationOnce(() => new Promise(resolve => { finishOldRun = resolve }))
  const card = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('测试策略'))!
  await act(async () => card.click()); await settle()
  await chooseDate('2026-10-09'); await settle()
  expect(api.screenerRunPreset).toHaveBeenLastCalledWith('test', undefined, '2026-10-09', undefined, 'etf', '30m')
  await act(async () => finishOldRun({ strategy: 'test', as_of: '2026-10-16', rows: [], total: 99, elapsed_ms: 0 }))
  await settle()
  expect(host.textContent).not.toContain('命中 99')
  expect(host.textContent).toContain('命中 0')
})

it('ETF 30F 全部视图切换日期后加载新日期明细，旧批次不能改回日期', async () => {
  await render('etf'); await click('30F')
  let finishOldRun!: (result: any) => void
  vi.mocked(api.screenerRunAll).mockImplementationOnce(() => new Promise(resolve => { finishOldRun = resolve }))
  await click('显示全部策略个股')
  await chooseDate('2026-10-09'); await settle()
  await act(async () => finishOldRun({ as_of: '2026-10-16', results: { test: { as_of: '2026-10-16', rows: [], total: 99 } } }))
  await settle(); await settle()
  expect(api.screenerRunAll).toHaveBeenLastCalledWith('2026-10-09', ['test'], 'etf', '30m', false)
  expect(host.querySelector<HTMLInputElement>('[aria-label="选股日期"]')!.value).toBe('2026-10-09')
  expect(host.textContent).not.toContain('99')
})

it.each(['1d', '30m', '1m'])('ETF %s 单策略与保存设置后的重跑传入所选日期', async timeframe => {
  await render('etf'); await chooseDate('2026-10-09')
  if (timeframe !== '1d') await click(timeframe === '30m' ? '30F' : '分钟')
  const card = host.querySelector<HTMLButtonElement>('button[title="测试策略"]')
    ?? [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('测试策略'))!
  await act(async () => card.click()); await settle()
  expect(api.screenerRunPreset).toHaveBeenLastCalledWith('test', undefined, '2026-10-09', undefined, 'etf', timeframe)
  await click('策略设置'); await click('保存测试设置')
  expect(api.screenerRunPreset).toHaveBeenLastCalledWith('test', undefined, '2026-10-09', undefined, 'etf', timeframe)
})

it('没有可用默认日期且未选择时仍由后端决定最新日期', async () => {
  fixture.latest = ''
  await render('etf')
  const card = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('测试策略'))!
  await act(async () => card.click()); await settle()
  expect(api.screenerRunPreset).toHaveBeenLastCalledWith('test', undefined, undefined, undefined, 'etf', '1d')
})

it.each(['1d', '30m'])('股票 %s 仍按所选日期运行', async timeframe => {
  await render('stock'); await chooseDate('2026-10-09')
  if (timeframe === '30m') await click('30F')
  const card = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('测试策略'))!
  await act(async () => card.click()); await settle()
  expect(api.screenerRunPreset).toHaveBeenLastCalledWith('test', undefined, '2026-10-09', undefined, 'stock', timeframe)
})
