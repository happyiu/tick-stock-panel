// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, type IndicatorMonitorRule, type IndicatorMonitorEvent } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { IndicatorMonitors } from './IndicatorMonitors'

vi.mock('@/components/KLineCandlestick', () => ({ KLineCandlestick: () => null }))
vi.mock('@/components/StockDailyKChart', () => ({ toOHLC: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { indicatorMonitors: vi.fn(), indicatorMonitorEvents: vi.fn(), instrumentNames: vi.fn() } }))

const rule = (id: string): IndicatorMonitorRule => ({
  id, symbol: '159605.SZ', asset_type: 'etf', indicator_id: 'test', period: '1d',
  signal_ids: ['buy'], mode: 'both', channels: [], enabled: true, compare_days: 1,
  generation: 1, status: 'running', definition: {
    id: 'test', name: id, source: 'custom', pane: 'main', description: '', formula: '', revision: 1, height: 100,
  },
})
const event = (ruleId: string): IndicatorMonitorEvent => ({
  event_id: ruleId, rule_id: ruleId, ts: 1, symbol: '159605.SZ', asset_type: 'etf',
  indicator_name: '同一个指标', indicator_id: 'test', period: '1d', signal_name: '进攻',
  phase: 'preview', bar_end: '2026-10-23 15:00', message: `${ruleId}的信号`, price: 1,
  confirmation: 'pending', deliveries: {},
})
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient
const filterButtons = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
const records = () => host.querySelector('[aria-label="指标触发记录"]')!
const click = async (button: HTMLButtonElement) => { await act(async () => button.click()) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const rules = { items: [rule('规则一'), rule('规则二'), rule('无记录')] }
  const events = { items: [event('规则一'), event('规则二')] }
  vi.mocked(api.instrumentNames).mockResolvedValue({ names: { '159605.SZ': '中概互联ETF广发', '510300.SH': '沪深300ETF' } })
  vi.mocked(api.indicatorMonitors).mockResolvedValue(rules)
  vi.mocked(api.indicatorMonitorEvents).mockResolvedValue(events)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(QK.indicatorMonitors, rules)
  client.setQueryData(QK.indicatorMonitorEvents, events)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<QueryClientProvider client={client}><IndicatorMonitors /></QueryClientProvider>))
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals() })

it('按监控规则筛选同一指标的事件，切换选中项和再次点击恢复全部', async () => {
  expect(records().querySelectorAll('li')).toHaveLength(2)
  await click(filterButtons()[0])
  expect(filterButtons()[0].getAttribute('aria-pressed')).toBe('true')
  expect(records().querySelectorAll('li')).toHaveLength(1)
  expect(records().textContent).toContain('规则一的信号')
  expect(records().textContent).not.toContain('规则二的信号')
  await click(filterButtons()[1])
  expect(filterButtons()[0].getAttribute('aria-pressed')).toBe('false')
  expect(records().textContent).toContain('规则二的信号')
  expect(records().textContent).not.toContain('规则一的信号')
  await click(filterButtons()[1])
  expect(records().querySelectorAll('li')).toHaveLength(2)
})

it('筛选无事件的监控显示空态，可恢复全部；选中的规则移除后恢复全部', async () => {
  await click(filterButtons()[2])
  expect(records().textContent).toContain('此监控暂无触发记录')
  expect(records().querySelector('ul')).toBeNull()
  await click([...records().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '显示全部记录')!)
  expect(records().querySelectorAll('li')).toHaveLength(2)
  await click(filterButtons()[0])
  await act(async () => { client.setQueryData(QK.indicatorMonitors, { items: [rule('规则二')] }); await new Promise(r => setTimeout(r, 0)) })
  expect(records().querySelectorAll('li')).toHaveLength(2)
  expect(filterButtons()[0].getAttribute('aria-pressed')).toBe('false')
})

it('卡片内的删除操作不切换筛选，只打开确认弹窗', async () => {
  await click(filterButtons()[0])
  const deleteButton = [...host.querySelectorAll<HTMLButtonElement>('article button')].find(b => b.textContent === '删除')!
  await click(deleteButton)
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('删除这条指标监控')
  expect(filterButtons()[0].getAttribute('aria-pressed')).toBe('true')
  expect(records().querySelectorAll('li')).toHaveLength(1)
})

it('批量补全监控和历史记录的标的名称，覆盖已删除监控及名称缺失', async () => {
  await act(async () => {
    client.setQueryData(QK.indicatorMonitorEvents, { items: [event('规则一'),
      { ...event('已删除'), symbol: '510300.SH' }, { ...event('未知'), symbol: '999999.SZ' }] })
    await new Promise(r => setTimeout(r, 0))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  expect(api.instrumentNames).toHaveBeenLastCalledWith(['159605.SZ', '510300.SH', '999999.SZ'])
  expect(host.querySelector('article')?.textContent).toContain('中概互联ETF广发')
  expect(records().textContent).toContain('159605.SZ 中概互联ETF广发')
  expect(records().textContent).toContain('510300.SH 沪深300ETF')
  expect(records().textContent).toContain('999999.SZ')
  expect(records().textContent).not.toContain('undefined')
})
