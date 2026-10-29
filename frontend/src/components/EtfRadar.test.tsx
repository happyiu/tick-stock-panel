// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { EtfRadar } from './EtfRadar'
const mock = vi.hoisted(() => ({ read: vi.fn(), scan: vi.fn() }))
vi.mock('@/components/DatePicker', () => ({ DatePicker: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <input aria-label="选择快照日期" value={value} onChange={e => onChange(e.target.value)} /> }))
vi.mock('@/lib/api', () => ({ api: { etfRadar: mock.read, etfRadarScan: mock.scan } }))
it('filters cached signals without rescanning and passes snapshot context to details', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const signal = { id: 'one', symbol: '510300.SH', code: '510300', name: '沪深300ETF', category: '宽基', variant: 'B1', age: 0, availableDate: '2026-10-28', structureDate: '2026-10-26' }
  mock.read.mockResolvedValue({ date: '2026-10-28', dates: ['2026-10-28'], needs_update: false, snapshot: { date: '2026-10-28', computed_at: '2026-10-28T15:08:45+08:00', range: { start: '2024-10-28', end: '2026-10-28' }, total: 1, counts: { ready: 1 }, buy_count: 1, sell_count: 0, signals: [signal, ...Array.from({ length: 5 }, (_, i) => ({ ...signal, id: `extra-${i}`, symbol: `extra-${i}`, name: `其他ETF${i}` }))], failures: [] } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  const root = createRoot(host)
  const select = vi.fn()
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><EtfRadar onSelect={select} /></QueryClientProvider>))
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    await act(async () => (host.querySelector('[aria-label="沪深300ETF B1"]') as HTMLButtonElement).click())
    expect(host.textContent).toContain('2026-10-28 15:08')
    expect(host.textContent).not.toContain('收盘快照')
    expect(select).toHaveBeenCalledWith(signal, { start: '2024-10-28', end: '2026-10-28' }, false)
    const list = host.querySelector('[aria-label="雷达信号列表"]')!
    expect(list.querySelectorAll('button').length).toBe(6)
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent?.includes('查看全部'))!.click())
    const collapse = [...host.querySelectorAll('button')].find(b => b.textContent === '收起列表' && list.contains(b))!
    expect(collapse).toBeDefined()
    await act(async () => collapse.click())
    expect(list.querySelectorAll('button').length).toBe(6)
    const side = host.querySelector('[aria-label="雷达方向"]') as HTMLSelectElement
    await act(async () => { side.value = 'S'; side.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.textContent).toContain('暂无有效候选信号')
    expect(mock.scan).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('全池1')
    expect([...host.querySelectorAll('button')].some(b => b.textContent === '折叠')).toBe(false)
  } finally {
    await act(async () => root.unmount())
    client.clear()
  }
})


it('shows cached dates without scanning, clears missing dates and ignores stale scan responses', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mock.read.mockReset()
  mock.scan.mockReset()
  const cached = { date: '2026-10-28', dates: ['2026-10-28', '2026-10-27'], needs_update: true, job_id: 'other', job_date: '2026-10-27', snapshot: { date: '2026-10-28', range: { start: '2024-10-28', end: '2026-10-28' }, signals: [], failures: [] } }
  mock.read.mockImplementation((date: string) => Promise.resolve(date === '2026-10-27' ? { ...cached, date, snapshot: null, job_id: null } : cached))
  let finish!: (value: { job_id: string; date: string }) => void
  mock.scan.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  const root = createRoot(host)
  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
  const change = async (value: string) => {
    await act(async () => {
      const input = host.querySelector('input')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><EtfRadar onSelect={vi.fn()} /></QueryClientProvider>))
    await settle()
    expect(host.querySelector('[aria-label="信号雷达气泡图"]')).not.toBeNull()
    expect(mock.scan).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('等待前一任务')
    await change('2026-10-27')
    expect(mock.scan).toHaveBeenCalledWith('2026-10-27', false)
    expect(host.querySelector('[aria-label="信号雷达气泡图"]')).toBeNull()
    await change('2026-10-28')
    await act(async () => finish({ job_id: 'old-job', date: '2026-10-27' }))
    await settle()
    expect(host.querySelector('[aria-label="信号雷达气泡图"]')).not.toBeNull()
    expect(host.textContent).not.toContain('扫描排队中')
  } finally {
    await act(async () => root.unmount())
    client.clear()
  }
})
