// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QuoteConfigCard } from './QuoteConfigCard'

let host: HTMLDivElement
let root: Root
const save = vi.fn()
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  host = document.createElement('div'); document.body.append(host)
  root = createRoot(host)
  save.mockReset().mockResolvedValue({})
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
function Card() {
  const [open, setOpen] = useState(false)
  const [selfInterval, setSelfInterval] = useState(10)
  const [poolEnabled, setPoolEnabled] = useState(false)
  return <QuoteConfigCard enabled={false} running={false} isTrading={false} loading={false} toggling={false}
    onToggle={() => {}} lastFetchMs={new Date('2026-10-22T10:00:01+08:00').getTime()}
    intervalS={6} intervalMin={1} intervalMax={60} onIntervalChange={v => save('stock', v)}
    showIntervalEdit={open} onShowIntervalEdit={() => setOpen(v => !v)}
    etfWatchlist={{ intervalS: selfInterval, intervalMin: 1, intervalMax: 3600,
      lastFetchMs: new Date('2026-10-22T10:00:02+08:00').getTime(),
      onIntervalChange: async v => { await save('etf_watchlist', v); setSelfInterval(v) } }}
    etfPool={{ enabled: poolEnabled, toggling: false, onToggle: v => { save('realtime_pull_etf', v); setPoolEnabled(v) }, intervalS: 60, intervalMin: 1, intervalMax: 3600, lastFetchMs: null,
      onIntervalChange: v => save('etf_pool', v) }} />
}
async function render() { await act(async () => root.render(<Card />)) }
async function clickGear(label: string) {
  await act(async () => host.querySelector<HTMLButtonElement>('[title="设置' + label + '轮询间隔"]')!.click())
}
async function fill(value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="number"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit() {
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}
it('shows three distinct intervals and successful fetch times', async () => {
  await render()
  expect(host.querySelector('section[aria-label="股票"]')?.textContent).toContain('6s')
  expect(host.querySelector('section[aria-label="自选 ETF"]')?.textContent).toContain('10s')
  expect(host.querySelector('section[aria-label="ETF 池"]')?.textContent).toContain('60s')
  expect(host.querySelector('section[aria-label="ETF 池"]')?.textContent).toContain('—')
  expect(host.querySelectorAll('input')).toHaveLength(0)
})
it('uses a numeric editor and saves only the selected scope', async () => {
  await render(); await clickGear('自选 ETF')
  expect(host.querySelector('input[type="range"]')).toBeNull()
  await fill('15'); await submit()
  expect(save).toHaveBeenCalledWith('etf_watchlist', 15)
  expect(host.querySelector('section[aria-label="自选 ETF"]')?.textContent).toContain('15s')
  expect(host.querySelector('section[aria-label="股票"]')?.textContent).toContain('6s')
  expect(host.querySelector('section[aria-label="ETF 池"]')?.textContent).toContain('60s')
})
it('blocks empty or out of range input and keeps the old interval on save failure', async () => {
  await render(); await clickGear('ETF 池')
  for (const value of ['', '0', '3601']) { await fill(value); await submit() }
  expect(save).not.toHaveBeenCalled()
  save.mockRejectedValueOnce(new Error('offline'))
  await fill('120'); await submit()
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('保存失败')
  expect(host.querySelector('section[aria-label="ETF 池"]')?.textContent).toContain('60s')
})

it('toggles the ETF pool scope independently of the realtime master switch', async () => {
  await render()
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="ETF 池行情"]')!
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  await act(async () => toggle.click())
  expect(save).toHaveBeenCalledWith('realtime_pull_etf', true)
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(host.querySelector('[aria-label="实时行情"]')?.getAttribute('aria-checked')).toBe('false')
  await act(async () => toggle.click())
  expect(save).toHaveBeenCalledWith('realtime_pull_etf', false)
})
