// @vitest-environment jsdom
import { act, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Indices } from './Indices'

type MinuteResponse = {
  symbol: string
  date: string
  rows: { datetime: string; close: number }[]
}
const fixtures = vi.hoisted(() => ({
  pending: [] as { symbol: string; day: string; resolve: (value: MinuteResponse) => void; reject: (error: Error) => void }[],
  mounts: 0,
  minuteCap: true,
  panelProps: {} as Record<string, any>,
}))

vi.mock('@/lib/api', () => ({
  api: {
    watchlistList: async () => ({ symbols: [{ symbol: '000001.SH', added_at: '2026-09-10T02:00:00Z' }] }),
    chartIndicators: async () => ({ items: [], errors: [] }),
    indexQuotes: async () => ({ rows: [] }),
    indexDaily: async (symbol: string) => ({
      symbol,
      rows: ['2026-09-09', '2026-09-10', '2026-09-11'].map(date => ({
        date, open: 10, high: 12, low: 9, close: 11, volume: 1,
      })),
    }),
    indexMinute: (symbol: string, day: string) => new Promise<MinuteResponse>((resolve, reject) => {
      fixtures.pending.push({ symbol, day, resolve, reject })
    }),
  },
}))
vi.mock('@/lib/useSharedQueries', () => ({
  useCapabilities: () => ({ data: { capabilities: { 'kline.minute.batch': fixtures.minuteCap } } }),
}))
vi.mock('@/components/StockPanel', () => ({
  StockPanel: (props: Record<string, any>) => {
    fixtures.panelProps = props
    useEffect(() => props.onSelectedDateChange('2026-09-11'), [props.symbol])
    return <div data-kline>{['2026-09-09', '2026-09-10', '2026-09-11'].map(day => (
      <button key={day} data-day={day} onClick={() => props.onSelectedDateChange(day)}>{day}</button>
    ))}
      <button onClick={props.onAddStrategy}>添加策略</button>
      <button onClick={props.onAddSignal}>添加信号</button>
    </div>
  },
}))
vi.mock('@/components/screener/StrategyPickerDialog', () => ({
  StrategyPickerDialog: (props: Record<string, any>) => <button data-strategy-asset={props.assetType}
    onClick={() => props.onSelect({ id: 'ma_golden_cross', name: 'MA 金叉' })}>选择MA策略</button>,
}))
vi.mock('@/components/screener/ChartSignalPickerDialog', () => ({
  ChartSignalPickerDialog: (props: Record<string, any>) => <button data-signal-asset={props.assetType}
    onClick={() => props.onApply([{ id: 'signal_macd_golden', name: 'MACD金叉', kind: 'entry' }])}>应用信号</button>,
}))
vi.mock('@/components/EChartsIntraday', () => ({
  EChartsIntraday: ({ data, date }: { data: MinuteResponse['rows']; date: string }) => {
    const [mount] = useState(() => ++fixtures.mounts)
    return <div data-chart data-mount={mount}>{`${date}|${data[0].datetime}|${data[0].close}`}</div>
  },
}))

let host: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  fixtures.pending.length = 0
  fixtures.mounts = 0
  fixtures.minuteCap = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: {
    retry: false, staleTime: Infinity, gcTime: Infinity,
  } } })
})

afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
  host.remove()
})

// React Query batches observer notifications on the next timer tick.
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
}

async function resolveDay(day: string, close: number) {
  const index = fixtures.pending.findIndex(call => call.day === day)
  expect(index).toBeGreaterThanOrEqual(0)
  const [call] = fixtures.pending.splice(index, 1)
  await act(async () => call.resolve({
    symbol: call.symbol, date: day, rows: [{ datetime: `${day}T09:35:00`, close }],
  }))
  await settle()
}

async function clickDay(day: string) {
  await clickTab('K 线')
  const button = host.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
  await settle()
  await clickTab('分时')
}

async function clickTab(name: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find(tab => tab.textContent?.trim() === name)
  expect(button).toBeDefined()
  await act(async () => button!.click())
  await settle()
}

async function renderPage() {
  await act(async () => root.render(
    <MemoryRouter><QueryClientProvider client={client}><Indices /></QueryClientProvider></MemoryRouter>,
  ))
  await settle()
}

it('defaults to full-width K line and requests minutes only while the intraday tab is open', async () => {
  await renderPage()
  const kline = host.querySelector('[data-kline]')
  expect(kline?.closest('[hidden]')).toBeNull()
  expect(fixtures.pending).toHaveLength(0)
  expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe('K 线')

  await clickTab('分时')
  expect(kline?.closest('[hidden]')).not.toBeNull()
  expect(fixtures.pending).toHaveLength(1)
  expect(host.textContent).toContain('分时加载中')
  await resolveDay('2026-09-11', 11)
  expect(host.querySelector('[data-chart]')).not.toBeNull()

  await clickTab('K 线')
  expect(host.querySelector('[data-kline]')).toBe(kline)
  expect(kline?.closest('[hidden]')).toBeNull()
  expect(host.querySelector('[data-chart]')).toBeNull()
  await act(async () => { void client.invalidateQueries({ queryKey: ['index-minute'] }) })
  await settle()
  expect(fixtures.pending).toHaveLength(0)
})

it('shows a capability message without requesting minutes when unavailable', async () => {
  fixtures.minuteCap = false
  await renderPage()
  await clickTab('分时')
  expect(host.textContent).toContain('指数分时数据不可用')
  expect(fixtures.pending).toHaveLength(0)
  await clickTab('K 线')
  expect(host.querySelector('[data-kline]')?.closest('[hidden]')).toBeNull()
})

it('changes intraday dates directly and clears the previous index chart when switching symbols', async () => {
  await renderPage()
  await clickTab('分时')
  await resolveDay('2026-09-11', 11)
  const input = host.querySelector<HTMLInputElement>('input[type="date"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '2026-09-10')
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(host.querySelector('[data-chart]')).toBeNull()
  await resolveDay('2026-09-10', 10)
  expect(host.querySelector('[data-chart]')?.textContent).toContain('2026-09-10|')

  const nextIndex = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent?.includes('深证成指'))!
  await act(async () => nextIndex.click())
  await settle()
  expect(host.querySelector('[data-chart]')).toBeNull()
  expect(fixtures.pending.at(-1)?.symbol).toBe('399001.SZ')
  expect(fixtures.pending.at(-1)?.day).toBe('2026-09-11')
  await resolveDay('2026-09-11', 22)
  expect(host.querySelector('[data-chart]')?.textContent).toBe('2026-09-11|2026-09-11T09:35:00|22')
})

it('shows empty and failed minute responses and allows retry', async () => {
  await renderPage()
  await clickTab('分时')
  const [call] = fixtures.pending.splice(0, 1)
  await act(async () => call.resolve({ symbol: call.symbol, date: call.day, rows: [] }))
  await settle()
  expect(host.textContent).toContain('暂无分时数据')

  await act(async () => { void client.invalidateQueries({ queryKey: ['index-minute'] }) })
  await settle()
  const [failed] = fixtures.pending.splice(0, 1)
  await act(async () => failed.reject(new Error('network error')))
  await settle()
  expect(host.textContent).toContain('指数分时加载失败')
  const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '重试')
  expect(retry).toBeDefined()
  await act(async () => retry!.click())
  await settle()
  await resolveDay('2026-09-11', 11)
  expect(host.querySelector('[data-chart]')).not.toBeNull()
})

it('keeps selected dates isolated across delayed, out-of-order and cached responses', async () => {
  await renderPage()
  await clickTab('分时')
  const chart = () => host.querySelector<HTMLElement>('[data-chart]')
  await resolveDay('2026-09-11', 11)
  expect(chart()?.textContent).toBe('2026-09-11|2026-09-11T09:35:00|11')

  await clickDay('2026-09-10')
  expect(chart()).toBeNull()
  await clickDay('2026-09-09')
  await resolveDay('2026-09-10', 10)
  expect(chart()).toBeNull()
  await resolveDay('2026-09-09', 9)
  expect(chart()?.textContent).toBe('2026-09-09|2026-09-09T09:35:00|9')

  const mount9 = chart()?.dataset.mount
  await clickDay('2026-09-11')
  expect(chart()?.textContent).toBe('2026-09-11|2026-09-11T09:35:00|11')
  expect(chart()?.dataset.mount).not.toBe(mount9)

  const mount11 = chart()?.dataset.mount
  await act(async () => { void client.invalidateQueries({ queryKey: ['index-minute'] }) })
  await settle()
  expect(chart()?.textContent).toBe('2026-09-11|2026-09-11T09:35:00|11')
  await resolveDay('2026-09-11', 12)
  expect(chart()?.textContent).toBe('2026-09-11|2026-09-11T09:35:00|12')
  expect(chart()?.dataset.mount).toBe(mount11)
})


it('reuses the complete detail panel and connects index strategy and signal selection', async () => {
  await renderPage()
  expect(fixtures.panelProps.rightPaneMode).toBe('technical')
  expect(fixtures.panelProps.resizableSplit).toBe(true)
  expect(fixtures.panelProps.independentPaneScroll).toBe(true)
  expect(fixtures.panelProps.showLimitMarkers).toBe(false)
  expect(fixtures.panelProps.addedDate).toBe('2026-09-10')
  expect(fixtures.panelProps.inWatchlist).toBe(true)
  const click = async (label: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!
    await act(async () => button.click()); await settle()
  }
  await click('添加策略')
  expect(host.querySelector('[data-strategy-asset]')?.getAttribute('data-strategy-asset')).toBe('index')
  await click('选择MA策略')
  expect(fixtures.panelProps.selectedStrategy.id).toBe('ma_golden_cross')
  await click('添加信号')
  expect(host.querySelector('[data-signal-asset]')?.getAttribute('data-signal-asset')).toBe('index')
  await click('应用信号')
  expect(fixtures.panelProps.selectedSignals[0].id).toBe('signal_macd_golden')
  await click('周 K')
  expect(fixtures.panelProps.period).toBe('1w')
  expect(fixtures.panelProps.selectedStrategy).toBeNull()
  expect(fixtures.panelProps.selectedSignals).toEqual([])
})
