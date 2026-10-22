// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { CapabilityRoutingSection } from './DataSources'

const fixtures = vi.hoisted(() => ({ update: vi.fn(async (_changes: object) => ({})) }))
vi.mock('@/components/Toast', () => ({ toast: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: {
  capabilityMatrix: async () => ({ capabilities: [
    { id: 'daily', group: 'general', label: '日K', field: 'daily_data_provider', default: 'tickflow', current: 'fuyao', effective: 'fuyao', usable: true, current_display: 'fuyao', effective_display: 'fuyao', candidates: [{ name: 'fuyao', display: 'fuyao' }], pending: [] },
    { id: 'etf_daily', group: 'etf', label: 'ETF池日K', field: 'etf_daily_data_provider', default: 'tickflow', current: 'tickflow', effective: 'tickflow', usable: true, current_display: 'TickFlow', effective_display: 'TickFlow', candidates: [{ name: 'tickflow', display: 'TickFlow' }, { name: 'astockdata', display: 'a-stock-data' }], pending: [] },
  ] }),
  updateDataProviders: fixtures.update,
} }))

it('renders the ETF route separately and changes or resets only its preference', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <CapabilityRoutingSection />
      <CapabilityRoutingSection group="etf" title="ETF 能力路由" />
    </QueryClientProvider>))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    const sections = host.querySelectorAll('section')
    expect(sections[0].textContent).toContain('日K')
    expect(sections[0].textContent).not.toContain('ETF池日K')
    expect(sections[1].textContent).toContain('ETF 能力路由')
    expect(sections[1].textContent).toContain('当前TickFlow')
    const source = Array.from(sections[1].querySelectorAll('button')).find(b => b.textContent === 'a-stock-data')!
    await act(async () => source.click())
    expect(fixtures.update).toHaveBeenLastCalledWith({ etf_daily_data_provider: 'astockdata' })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    // A group reset must not reset the independently selected stock route.
    const stockReset = Array.from(sections[0].querySelectorAll('button')).find(b => b.textContent?.includes('恢复默认'))!
    await act(async () => stockReset.click())
    expect(fixtures.update).toHaveBeenLastCalledWith({ daily_data_provider: 'tickflow' })
  } finally {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
  }
})
