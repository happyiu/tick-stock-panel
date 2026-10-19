// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IndicatorMonitorEditor } from './IndicatorMonitorEditor'
import { api } from '@/lib/api'

vi.mock('@/lib/useChartIndicators', () => ({ useChartIndicators: () => ({ items: [{
  id: 'custom-main', source: 'custom', name: '自建主图', pane: 'main',
  monitor_signals: [{ id: 'buy', name: '试仓', variable: 'hit', periods: ['30m'] }],
}], isError: false }) }))
vi.mock('@/lib/api', () => ({ api: { saveIndicatorMonitor: vi.fn(async () => ({})), instrumentSearch: vi.fn(async () => ({ results: [] })) } }))
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient
const close = vi.fn()
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 1 }); vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<QueryClientProvider client={client}><IndicatorMonitorEditor preset={{ symbol: '510300.SH', asset_type: 'etf', indicator_id: 'custom-main' }} onClose={close} /></QueryClientProvider>))
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals() })
it('详情页预填标的、指标和30f，默认实时加确认；无信号不可保存', async () => {
  const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '保存监控')!
  expect(host.textContent).toContain('510300.SH')
  expect(host.textContent).toContain('后台每60秒检查')
  expect((host.querySelector('[aria-label="触发方式"]') as HTMLSelectElement).value).toBe('both')
  expect(save.disabled).toBe(true)
  await act(async () => (host.querySelector('fieldset input') as HTMLInputElement).click())
  expect(save.disabled).toBe(false)
  await act(async () => save.click()); await settle()
  expect(api.saveIndicatorMonitor).toHaveBeenCalledWith(expect.objectContaining({ symbol: '510300.SH', asset_type: 'etf', signal_ids: ['buy'], period: '30m', mode: 'both', channels: [] }), undefined)
  expect(close).toHaveBeenCalledOnce()
})
it('切换周期清除不适用信号并引导配置，显示后端错误且保留表单', async () => {
  await act(async () => (host.querySelector('fieldset input') as HTMLInputElement).click())
  const period = host.querySelector('[aria-label="监控周期"]') as HTMLSelectElement
  await act(async () => { period.value = '1d'; period.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(host.textContent).toContain('该周期没有可监控信号')
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/indicators?edit=custom-main')
  expect(host.querySelector('a')?.textContent).toBe('编辑当前指标的监控信号')
  expect(host.textContent).toContain('当前指标“自建主图”')
  await act(async () => { period.value = '30m'; period.dispatchEvent(new Event('change', { bubbles: true })) })
  expect((host.querySelector('fieldset input') as HTMLInputElement).checked).toBe(false)
  await act(async () => (host.querySelector('fieldset input') as HTMLInputElement).click())
  vi.mocked(api.saveIndicatorMonitor).mockRejectedValueOnce(new Error('分钟数据能力不可用'))
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '保存监控')!.click()); await settle()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('分钟数据能力不可用')
  expect(close).not.toHaveBeenCalled()
})
