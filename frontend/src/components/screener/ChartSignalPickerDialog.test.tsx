// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { ChartSignalPickerDialog } from './ChartSignalPickerDialog'

vi.mock('@/lib/api', () => ({ api: { customSignalsList: async () => ({ signals: [
  { id: 'limit-wrapper', name: '自定义涨停', kind: 'entry', enabled: true, conditions: [{ left: 'signal_limit_up', op: '==', right: '1' }] },
  { id: 'formula', name: '公式进攻', kind: 'entry', enabled: true, definition_type: 'formula', conditions: [] },
  { id: 'condition', name: '条件进攻', kind: 'entry', enabled: true, conditions: [] },
] }) } }))

it('preserves the default chart picker and its apply callback', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const apply = vi.fn()
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><ChartSignalPickerDialog open period="1d" selected={[]} onClose={() => {}} onApply={apply} /></QueryClientProvider>))
    expect(host.textContent).toContain('叠加到当前 K 线')
    expect(host.querySelector('[aria-label="信号组合规则"]')).toBeNull()
    const limit = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')).find(button => button.textContent?.includes('signal_limit_up'))!
    expect(limit.disabled).toBe(false)
    await act(async () => limit.click())
    const confirm = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '应用 (1)')!
    await act(async () => confirm.click())
    expect(apply).toHaveBeenCalledWith([{ id: 'signal_limit_up', name: '涨停', kind: 'entry' }])
  } finally {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
  }
})

it.each(['1d', '30m', '1w', '1mo'] as const)('limits formula selections to daily and 30F (%s)', async period => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><ChartSignalPickerDialog open period={period} selected={[]} onClose={() => {}} onApply={() => {}} /></QueryClientProvider>))
    for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(host.textContent).toContain('条件进攻')
    expect(host.textContent?.includes('公式进攻')).toBe(period === '1d' || period === '30m')
  } finally {
    await act(async () => root.unmount()); client.clear(); host.remove()
  }
})

it('index charts expose price signals and exclude stock price-limit signals', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><ChartSignalPickerDialog open assetType="index" period="1d" selected={[]} onClose={() => {}} onApply={() => {}} /></QueryClientProvider>))
    expect(host.textContent).toContain('signal_macd_golden')
    expect(host.textContent).not.toContain('signal_limit_up')
    expect(host.textContent).not.toContain('signal_limit_down')
    expect(host.textContent).not.toContain('自定义涨停')
  } finally {
    await act(async () => root.unmount()); client.clear(); host.remove()
  }
})
