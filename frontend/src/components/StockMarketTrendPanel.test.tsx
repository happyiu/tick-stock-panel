// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StockMarketTrendPanel, type StockMarketTrendItem } from './StockMarketTrendPanel'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(items: StockMarketTrendItem[]) {
  await act(async () => root.render(<StockMarketTrendPanel items={items} />))
}

const bars = (closes: number[]) => closes.map((close, index) => ({
  date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
  close,
}))

it('shows each latest signal date and the matching three-period interpretation', async () => {
  const rising = [...Array<number>(30).fill(100), 110]
  const falling = [...Array<number>(30).fill(100), 110, 112, 90]
  const items: StockMarketTrendItem[] = [
    { period: '1w', rows: bars(rising), loading: false, error: false, retry: vi.fn() },
    { period: '1d', rows: bars(falling), loading: false, error: false, retry: vi.fn() },
    { period: '30m', rows: bars(rising), loading: false, error: false, retry: vi.fn() },
  ]

  await render(items)

  expect(host.textContent).toContain('周线')
  expect(host.textContent).toContain('日线')
  expect(host.textContent).toContain('30F')
  expect(host.textContent).toContain('进攻')
  expect(host.textContent).toContain('撤退')
  expect(host.textContent).toContain('得分70/100')
  expect(host.textContent).toContain('多头调整中反弹')
  expect(host.textContent).toContain('中期上涨背景下尝试止跌')
})

it('calculates a weekly/daily score when the 30F data is missing', async () => {
  const rising = [...Array<number>(30).fill(100), 110]
  const items: StockMarketTrendItem[] = [
    { period: '1w', rows: bars(rising), loading: false, error: false, retry: vi.fn() },
    { period: '1d', rows: bars(rising), loading: false, error: false, retry: vi.fn() },
    { period: '30m', rows: [], loading: false, error: false, retry: vi.fn() },
  ]

  await render(items)

  expect(host.textContent).toContain('得分93/100')
  expect(host.textContent).toContain('周日多头共振')
  expect(host.textContent).toContain('30F暂无K线')
})

it('switches historical summaries between weekly and daily signals', async () => {
  const closes = [...Array<number>(30).fill(100), 110, 112, 90]
  const items: StockMarketTrendItem[] = [
    { period: '1w', rows: bars(closes), loading: false, error: false, retry: vi.fn() },
    { period: '1d', rows: bars(closes), loading: false, error: false, retry: vi.fn() },
    { period: '30m', rows: closes.map((close, index) => ({ date: new Date(Date.UTC(2026, 0, 1, 9, 30 + index * 30)).toISOString().slice(0, 16), close })), loading: false, error: false, retry: vi.fn() },
  ]
  await render(items)
  const tabs = host.querySelectorAll<HTMLButtonElement>('[aria-label="历史汇总周期"] [role="tab"]')
  expect(tabs[0].getAttribute('aria-selected')).toBe('true')
  await act(async () => tabs[1].click())
  expect(tabs[1].getAttribute('aria-selected')).toBe('true')
  expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain('日线信号以日K收盘确认')
  await act(async () => tabs[2].click())
  expect(tabs[2].getAttribute('aria-selected')).toBe('true')
  expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain('30F信号范围')
  expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain('根30F')
})

it('shows missing-data and load-error states and allows retry', async () => {
  const retry = vi.fn()
  const items: StockMarketTrendItem[] = [
    { period: '1w', rows: [], loading: false, error: true, retry },
    { period: '1d', rows: [], loading: false, error: false, retry: vi.fn() },
    { period: '30m', rows: [], loading: false, error: false, retry: vi.fn() },
  ]

  await render(items)

  expect(host.textContent).toContain('加载失败')
  expect(host.textContent).toContain('暂无K线')
  expect(host.textContent).toContain('得分—')
  await act(async () => (host.querySelector('button') as HTMLButtonElement).click())
  expect(retry).toHaveBeenCalledOnce()
})
