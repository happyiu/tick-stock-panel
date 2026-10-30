// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { StockDowPanel } from './StockDowPanel'
import type { DowAnalysis } from '@/lib/dow'
it('展示缺失周期、受损趋势和重试，不伪造多周期同向', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  const analysis = { status: 'ok', trend: 'down', structure: 'down', damaged: true, pivots: [], levels: {}, events: [], issues: [], volume: null } as unknown as DowAnalysis
  let retried = false
  await act(async () => root.render(<StockDowPanel items={[{ period: '1d', analysis, loading: false, error: false, retry: () => {} }, { period: '30m', loading: false, error: true, retry: () => { retried = true } }]} selected="30m" onSelect={() => {}} enabled={false} onToggle={() => {}} supported={false} />))
  expect(host.textContent).toContain('下跌趋势受损')
  expect(host.textContent).not.toContain('多周期同向')
  expect(host.querySelector('button[disabled]')).not.toBeNull()
  const retry = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('点击重试'))!
  await act(async () => retry.click())
  expect(retried).toBe(true)
  await act(async () => root.unmount())
})

it('默认折叠依据，受损写为已发生，量能引用确认事件', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  const analysis = { status: 'ok', trend: 'down', structure: 'mixed', damaged: true,
    pivots: [{ label: 'LH', value: 12, date: '2025-01-01', confirmedAt: '2025-01-03' }], levels: {},
    events: [{ kind: 'wick', date: '2025-01-06', value: 12 }], issues: [], volume: 9,
    breakoutVolume: { date: '2025-01-04', direction: 'down', volumeRatio: 1.3 },
    paths: [{ kind: 'damage', direction: 'up', value: 12, satisfied: true }] } as unknown as DowAnalysis
  await act(async () => root.render(<StockDowPanel items={[{ period: '1d', analysis, loading: false, error: false, retry: () => {} }]} selected="1d" onSelect={() => {}} enabled={false} onToggle={() => {}} supported />))
  expect(host.querySelector('details')?.open).toBe(false)
  expect(host.textContent).toContain('收盘已突破原保护位 12')
  expect(host.textContent).toContain('1.30倍')
  expect(host.textContent).not.toContain('9.00倍')
  expect(host.textContent).not.toContain('共同偏')
  await act(async () => root.unmount())
})

it('历史确认保留原价位，新结构显示待确认，旧结构受损只等待新结构', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  const analysis = { status: 'ok', trend: 'up', structure: 'up', damaged: false,
    pivots: [], levels: {}, events: [], issues: [], volume: null,
    basis: { confirmation: { date: '2025-01-23', direction: 'up', value: 105.544 } },
    paths: [{ kind: 'confirmation', direction: 'up', value: 107.420, satisfied: false, structureReady: true }],
  } as unknown as DowAnalysis
  const render = () => root.render(<StockDowPanel items={[{ period: '1d', analysis, loading: false, error: false, retry: () => {} }]} selected="1d" onSelect={() => {}} enabled={false} onToggle={() => {}} supported />)
  await act(async () => render())
  expect(host.textContent).toContain('收盘突破 105.544')
  expect(host.textContent).toContain('结构需配合收盘突破 107.42')
  analysis.damaged = true
  analysis.paths = [{ kind: 'recovery', direction: 'up', value: null, satisfied: false, anchorDate: null, structureReady: false }]
  await act(async () => render())
  expect(host.textContent).toContain('等待新的同向高低点结构')
  expect(host.textContent).not.toContain('结构需配合收盘突破')
  await act(async () => root.unmount())
})
