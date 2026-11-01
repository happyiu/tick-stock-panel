// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import VolumeAnalysis from './VolumeAnalysis'

const calls = vi.hoisted(() => ({ symbols: [] as string[], options: [] as unknown[] }))
vi.mock('echarts', () => ({ init: () => ({ setOption: (option: unknown) => calls.options.push(option), resize: () => {}, dispose: () => {} }) }))
vi.mock('@/lib/api', () => ({ api: { indexQuotes: async () => ({ rows: [{ symbol: '000001.SH', last_price: 3599.02, change_pct: -1.44 }], count: 1 }), volumeTrend: async (symbol: string) => {
  calls.symbols.push(symbol)
  return { symbol, name: symbol, unit: 'CNY', as_of: '2026-10-30', data_time: '2026-10-30', source: 'stored', provisional: false,
    points: [{ date: '2026-10-30', amount: 1e8, ma5: 1e8, ma13: 1e8, ma28: 1e8, provisional: false }],
    crosses: [{ date: '2026-10-30', fast: 'ma5', slow: 'ma13', kind: 'golden', value: 1e8, provisional: false }] }
} } }))

let host: HTMLDivElement
let root: Root
let client: QueryClient
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} } })
  calls.symbols.length = 0
  calls.options.length = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })

it('loads the chosen index and filters crossover markers', async () => {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/volume-analysis']}><VolumeAnalysis /></MemoryRouter></QueryClientProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(calls.symbols).toEqual(['000001.SH'])
  expect(host.querySelectorAll('nav[aria-label="指数列表"] button')).toHaveLength(11)
  expect(host.textContent).toContain('3599.02')
  expect(host.textContent).toContain('MA5/MA13')
  const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  await act(async () => checkbox.click())
  expect(host.textContent).toContain('所选组合在当前窗口无交叉')
  const indexButton = [...host.querySelectorAll<HTMLButtonElement>('nav[aria-label="指数列表"] button')]
    .find(button => button.textContent?.includes('沪深300'))!
  await act(async () => indexButton.click())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(calls.symbols).toContain('000300.SH')
})
