// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { Commodity } from './Commodity'

vi.mock('@/lib/useSharedQueries', () => ({ useDataStatus: () => ({ data: {} }) }))
vi.mock('@/components/Toast', () => ({ toast: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: {
  commodityCatalog: async () => ({ items: [
    { symbol: 'XAU/USD', name: '黄金', category: 'precious_metal', kind: 'price', unit: 'USD/oz', frequency: '1d', source: 'goldapi' },
    { symbol: 'BTC', name: '比特币', category: 'crypto', kind: 'price', unit: 'USD', frequency: '1d', source: 'goldapi' },
    { symbol: 'WTI', name: 'WTI 原油', category: 'energy', kind: 'price', unit: 'USD/bbl', frequency: '1d', source: 'fred' },
    { symbol: 'NATURAL_GAS', name: '天然气', category: 'energy', kind: 'price', unit: 'USD/MMBtu', frequency: '1d', source: 'eia' },
  ], sources: {} }),
  commodityQuotes: async () => ({ source: 'goldapi', items: [] }),
  commodity: async () => ({ items: [], count: 0 }),
} }))

it('keeps price categories and energy prices after removing fundamentals', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}><Commodity /></QueryClientProvider></MemoryRouter>))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(host.textContent).not.toContain('能源基本面')
    expect(host.textContent).toContain('贵金属')
    expect(host.textContent).toContain('加密币')
    const energy = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.startsWith('能源'))!
    await act(async () => energy.click())
    expect(host.textContent).toContain('WTI 原油')
    expect(host.textContent).toContain('天然气')
    expect(host.textContent).not.toContain('原油库存')
    expect(host.textContent).not.toContain('炼厂开工率')
  } finally {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
  }
})
