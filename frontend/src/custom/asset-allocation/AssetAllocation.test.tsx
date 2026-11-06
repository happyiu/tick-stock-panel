// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import AssetAllocation from './AssetAllocation'

vi.mock('echarts', () => ({ init: () => ({ setOption() {}, resize() {}, dispose() {} }) }))
vi.mock('@/lib/api', () => ({ api: {
  allocationTracking: async () => ({}),
  allocationPortfolios: async () => ({ one: { name: '已保存', symbols: ['510300.SH'], lookback: 126, max_weight: 1 } }),
} }))

it('restores a saved portfolio and keeps draft selection for an infeasible allocation', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['allocation-portfolios'], { one: { name: '已保存', symbols: ['510300.SH'], lookback: 126, max_weight: 1 } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<QueryClientProvider client={client}><AssetAllocation /></QueryClientProvider>)
    await new Promise(resolve => setTimeout(resolve, 20))
  })
  const select = host.querySelector('select')!
  await act(async () => {
    select.value = 'one'; select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(host.textContent).toContain('510300.SH')
  expect(host.querySelector<HTMLInputElement>('[aria-label="回看交易日"]')!.value).toBe('126')
  await act(async () => root.unmount())
  client.clear()
  host.remove()
})
