// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChartIndicatorMenu } from './ChartIndicatorMenu'

vi.mock('@/lib/useChartIndicators', () => ({ useChartIndicators: () => ({ main: [{ key: 'custom', label: '测试主图', source: 'custom', monitor_signals: [{ id: 'buy' }] }, { key: 'unconfigured', label: '未配置信号主图', source: 'custom', monitor_signals: [] }], sub: [], isLoading: false, isError: false }) }))
vi.mock('./monitor/IndicatorMonitorEditor', () => ({ useIndicatorMonitors: () => ({ data: { items: [] }, isLoading: false, isError: false }), IndicatorMonitorEditor: ({ preset }: { preset: { symbol: string; period: string; indicator_id: string } }) => <div role="dialog" aria-label="添加指标监控">{preset.symbol} {preset.period} {preset.indicator_id}</div> }))
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient
const toggle = vi.fn()
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  toggle.mockReset(); client = new QueryClient()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<QueryClientProvider client={client}><ChartIndicatorMenu activeIndicators={[]} onToggle={toggle} monitorContext={{ symbol: '510300.SH', asset_type: 'etf', period: '30m', compare_days: 1 }} /></QueryClientProvider>))
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '指标')!.click())
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })
it('铃铛预填监控上下文，不切换图表指标', async () => {
  await act(async () => (host.querySelector('[aria-label="添加监控测试主图"]') as HTMLButtonElement).click())
  expect(toggle).not.toHaveBeenCalled()
  expect(host.querySelector('[aria-label="添加指标监控"]')?.textContent).toContain('510300.SH 30m custom')
  expect(host.querySelector('[aria-label="K线指标"]')).toBeNull()
})
it('指标行继续独立控制显示，不打开监控配置', async () => {
  await act(async () => (host.querySelector('[aria-label="测试主图"]') as HTMLButtonElement).click())
  expect(toggle).toHaveBeenCalledWith('custom')
  expect(host.querySelector('[aria-label="添加指标监控"]')).toBeNull()
})
it('未配置信号时铃铛仍打开监控弹窗，不自动跳转指标编辑页', async () => {
  const url = window.location.href
  await act(async () => (host.querySelector('[aria-label="添加监控未配置信号主图"]') as HTMLButtonElement).click())
  expect(toggle).not.toHaveBeenCalled()
  expect(host.querySelector('[aria-label="添加指标监控"]')?.textContent).toContain('510300.SH 30m unconfigured')
  expect(window.location.href).toBe(url)
})
