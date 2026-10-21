// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EtfPoolResponse } from '@/lib/api'
import { ETFPool } from './ETFPool'
import { useQuoteStream } from '@/lib/useQuoteStream'

const fixtures = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { etfPool: fixtures.request } }))
vi.mock('@/components/StockPreviewDialog', () => ({ StockPreviewDialog: ({ symbol }: { symbol: string }) => <div role="dialog">{symbol}</div> }))
let host: HTMLDivElement
let root: Root
let client: QueryClient
const response = (total = 45): EtfPoolResponse => ({
  rows: total ? [{ symbol: '510300.SH', code: '510300', name: '沪深300ETF', category: '宽基', exchange: 'SH' }] : [],
  total, catalog_total: 45, categories: [{ name: '宽基', count: 45 }], page: 1, page_size: 20,
})
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  fixtures.request.mockReset().mockResolvedValue(response())
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
})
afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  host.remove()
})
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
function LivePool({ enabled }: { enabled: boolean }) {
  useQuoteStream(enabled, undefined)
  return <ETFPool />
}
async function render(content = <ETFPool />) {
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}>{content}</QueryClientProvider></MemoryRouter>))
  await settle()
}
async function click(label: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click())
  await settle()
}
async function select(label: string, value: string) {
  await act(async () => {
    const element = host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}
it('paginates and resets the page when filters or page size change', async () => {
  await render()
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('1')
  expect(host.textContent).toContain('共 45 条')
  expect(host.textContent).not.toContain('浏览本地已同步的全部 ETF 目录')
  expect(host.querySelector('[aria-label="跳转页码"]')).toBeNull()
  const pager = host.querySelector('nav[aria-label="ETF 分页"]')!
  expect(pager.nextElementSibling?.querySelector('[aria-label="每页条数"]')).not.toBeNull()
  expect(host.querySelector<HTMLButtonElement>('[aria-label="上一页"]')!.disabled).toBe(true)
  await click('下一页')
  expect(fixtures.request.mock.lastCall?.[0].page).toBe(2)
  await select('ETF 分类', '宽基')
  expect(fixtures.request.mock.lastCall?.[0]).toMatchObject({ category: '宽基', page: 1 })
  expect(host.querySelector('[aria-label="交易所"]')).toBeNull()
  expect(host.querySelector('thead')?.textContent).not.toContain('交易所')
  await select('每页条数', '50')
  expect(fixtures.request.mock.lastCall?.[0]).toMatchObject({ category: '宽基', pageSize: 50, page: 1 })
  expect(fixtures.request.mock.lastCall?.[0]).not.toHaveProperty('exchange')
  expect(host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.disabled).toBe(true)
  await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === '510300.SH')!.click())
  await settle()
  expect(host.querySelector('[role="dialog"]')?.textContent).toBe('510300.SH')
})
it('shows clickable page numbers and ellipses for a large result set', async () => {
  fixtures.request.mockResolvedValue(response(400))
  await render()
  expect(host.querySelector('nav[aria-label="ETF 分页"]')?.textContent).toContain('12345…20')
  await click('第 5 页')
  expect(fixtures.request.mock.lastCall?.[0].page).toBe(5)
  expect(host.querySelector('nav[aria-label="ETF 分页"]')?.textContent).toContain('1…456…20')
  await click('第 20 页')
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('20')
  expect(host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.disabled).toBe(true)
})
it('debounces searches and resets pagination', async () => {
  await render()
  await click('下一页')
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('[aria-label="搜索 ETF"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' 黄金 ')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
  await settle()
  expect(fixtures.request.mock.lastCall?.[0]).toMatchObject({ q: '黄金', page: 1 })
})
it('formats ETF quotes, decimal changes, dates and missing values', async () => {
  const result = response()
  result.rows = [
    { ...result.rows[0], last_price: 4.1234, change_pct: .0123, quote_date: '2026-10-20' },
    { ...result.rows[0], symbol: '159605.SZ', last_price: 1.234, change_pct: -.025, quote_date: '2026-10-19' },
    { ...result.rows[0], symbol: '511010.SH', last_price: 100, change_pct: 0 },
    { ...result.rows[0], symbol: '159999.SZ', last_price: null, change_pct: null },
  ]
  fixtures.request.mockResolvedValue(result)
  await render()
  const rows = Array.from(host.querySelectorAll('tbody tr')).map(row => row.querySelectorAll('td'))
  expect(rows[0][2].textContent).toContain('4.123')
  expect(rows[0][2].textContent).toContain('2026-10-20')
  expect(rows[0][3].textContent).toBe('+1.23%')
  expect(rows[0][3].className).toContain('text-bull')
  expect(rows[1][3].textContent).toBe('-2.50%')
  expect(rows[1][3].className).toContain('text-bear')
  expect(rows[2][3].textContent).toBe('0.00%')
  expect(rows[3][2].textContent).toBe('—')
  expect(rows[3][3].textContent).toBe('—')
})
it('refreshes the current ETF page on a quote push only when realtime is enabled', async () => {
  let stream!: EventTarget
  class FakeEventSource extends EventTarget {
    constructor() { super(); stream = this }
    close() {}
  }
  vi.stubGlobal('EventSource', FakeEventSource)
  try {
    await render(<LivePool enabled={false} />)
    const updated = response()
    updated.rows[0] = { ...updated.rows[0], last_price: 4.5, change_pct: .02 }
    fixtures.request.mockResolvedValue(updated)
    await act(async () => { stream.dispatchEvent(new Event('quotes_updated')) })
    await settle()
    expect(fixtures.request).toHaveBeenCalledTimes(1)
    await render(<LivePool enabled />)
    await act(async () => { stream.dispatchEvent(new Event('quotes_updated')) })
    await settle()
    expect(fixtures.request).toHaveBeenCalledTimes(2)
    expect(host.querySelector('tbody')?.textContent).toContain('4.500')
    expect(host.querySelector('tbody')?.textContent).toContain('+2.00%')
  } finally {
    vi.unstubAllGlobals()
  }
})
it('shows loading, errors, retry and empty results', async () => {
  let resolve!: (value: EtfPoolResponse) => void
  fixtures.request.mockImplementationOnce(() => new Promise<EtfPoolResponse>(r => { resolve = r }))
  await render()
  expect(host.textContent).toContain('正在加载 ETF 列表')
  await act(async () => resolve(response(0)))
  await settle()
  expect(host.textContent).toContain('没有符合条件的 ETF')
  fixtures.request.mockRejectedValueOnce(new Error('目录不可用'))
  await click('刷新 ETF 列表')
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('目录不可用')
  fixtures.request.mockResolvedValue({ ...response(0), catalog_total: 0 })
  await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === '重试')!.click())
  await settle()
  expect(host.querySelector('a[href="/data"]')).not.toBeNull()
})
